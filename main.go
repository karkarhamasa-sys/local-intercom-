package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io/fs"
	"math/big"
	mrand "math/rand/v2"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/skip2/go-qrcode"
)

//go:embed web/*
var webFiles embed.FS

// Client represents a connected user (Director, Photographer, etc.)
type Client struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Role      string          `json:"role"`
	Conn      *websocket.Conn `json:"-"`
	Send      chan []byte     `json:"-"`
	LastSeen  time.Time       `json:"-"`
	Latency   int             `json:"latency"` // in ms
	Status    string          `json:"status"`  // Excellent, Good, Unstable, OutOfRange, Offline
	Muted     bool            `json:"muted"`   // Muted by director (cannot talk)
}

// ServerState maintains active room connections and routing rules
type ServerState struct {
	PIN                  string
	Clients              map[string]*Client
	ClientsMu            sync.RWMutex
	ClientsHearEachOther bool
	DirectorTargets      map[string]bool // Client IDs the director is broadcasting to
	DirectorRoles        map[string]bool // Roles the director is broadcasting to (e.g. "Photographer")
	DirectorAll          bool            // Is the director speaking to everyone
}

var state = ServerState{
	PIN:                  "1234", // Will be randomized on start
	Clients:              make(map[string]*Client),
	ClientsHearEachOther: false, // Default: clients only hear director to prevent chatter
	DirectorTargets:      make(map[string]bool),
	DirectorRoles:        make(map[string]bool),
	DirectorAll:          true, // Default: speak to everyone
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow local connections
	},
}

var detectedIPs []string

func main() {
	// 1. Randomize Session PIN (4 digits)
	state.PIN = fmt.Sprintf("%04d", mrand.IntN(9000)+1000)

	// 2. Detect Local Wi-Fi IP
	ips := getLocalIPs()
	detectedIPs = ips
	fmt.Println("==================================================================")
	fmt.Println("             🚀 INTERNAL WI-FI MULTI-CHANNEL INTERCOM             ")
	fmt.Println("==================================================================")
	fmt.Printf("[Server] Dynamic Session PIN Generated: \033[1;32m%s\033[0m\n", state.PIN)
	fmt.Println("[Server] Detected Local IP Addresses:")
	for _, ip := range ips {
		fmt.Printf("   👉 https://%s:8443 (Crew Link)\n", ip)
	}
	fmt.Println("[Server] Director Dashboard (Host Laptop Only):")
	fmt.Println("   👉 https://localhost:8443")
	fmt.Println("==================================================================")

	// 3. Generate dynamic SSL certificate
	cert, err := generateSelfSignedCert(ips)
	if err != nil {
		panic(fmt.Sprintf("Failed to generate self-signed SSL certificate: %v", err))
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
	}

	// 4. Setup Routes
	// Serve embedded static files
	sub, err := fs.Sub(webFiles, "web")
	if err != nil {
		panic(err)
	}
	http.Handle("/", http.FileServer(http.FS(sub)))

	// API to serve QR Code offline
	http.HandleFunc("/api/qrcode", qrHandler)

	// WebSocket handler
	http.HandleFunc("/ws", wsHandler)

	// Start Background connection supervisor to detect Out-of-Range or Disconnected clients
	go supervisorLoop()

	server := &http.Server{
		Addr:      ":8443",
		TLSConfig: tlsConfig,
	}

	fmt.Println("[Server] Running HTTPS server on port 8443...")
	err = server.ListenAndServeTLS("", "")
	if err != nil {
		panic(fmt.Sprintf("Failed to start server: %v", err))
	}
}

// qrHandler generates a local PNG QR Code for offline scanning
func qrHandler(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	if url == "" {
		http.Error(w, "missing url parameter", 400)
		return
	}
	png, err := qrcode.Encode(url, qrcode.Medium, 256)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Write(png)
}

// wsHandler upgrades to WebSocket, validates PIN, and handles room events
func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		fmt.Printf("[WS] Upgrade error: %v\n", err)
		return
	}

	// Read connection params
	name := r.URL.Query().Get("name")
	role := r.URL.Query().Get("role")
	pin := r.URL.Query().Get("pin")

	// Determine if host/director connection
	isLocalhost := false
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		isLocalhost = (host == "127.0.0.1" || host == "::1" || host == "localhost")
	}

	// Security check: Only bypass PIN if connecting from localhost as director
	if role == "Director" && isLocalhost {
		// Auto-authorized
	} else {
		// Regular client check
		if pin != state.PIN {
			_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"error","message":"Invalid Session PIN!"}`))
			_ = conn.Close()
			return
		}
	}

	// Create new client object
	clientID := fmt.Sprintf("%d", time.Now().UnixNano())
	client := &Client{
		ID:       clientID,
		Name:     name,
		Role:     role,
		Conn:     conn,
		Send:     make(chan []byte, 100),
		LastSeen: time.Now(),
		Latency:  0,
		Status:   "Excellent",
		Muted:    false,
	}

	state.ClientsMu.Lock()
	state.Clients[clientID] = client
	state.ClientsMu.Unlock()

	fmt.Printf("[WS] Client Joined: %s (%s) [ID: %s]\n", name, role, clientID)
	broadcastStatus()

	// Write worker
	go func() {
		for msg := range client.Send {
			err := conn.WriteMessage(websocket.BinaryMessage, msg)
			if err != nil {
				break
			}
		}
	}()

	// Read worker
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}

		client.LastSeen = time.Now()

		if msgType == websocket.BinaryMessage {
			// Handle raw PCM audio frame
			if client.Muted {
				continue // Silenced by director
			}
			routeAudio(client, data)
		} else if msgType == websocket.TextMessage {
			// Handle JSON commands
			handleJSONCommand(client, data)
		}
	}

	// Cleanup on disconnect
	state.ClientsMu.Lock()
	delete(state.Clients, clientID)
	// Remove from director targets
	delete(state.DirectorTargets, clientID)
	state.ClientsMu.Unlock()

	close(client.Send)
	_ = conn.Close()
	fmt.Printf("[WS] Client Disconnected: %s (%s) [ID: %s]\n", name, role, clientID)
	broadcastStatus()
}

// routeAudio distributes audio frames based on the matrix routing rules
func routeAudio(sender *Client, audioData []byte) {
	state.ClientsMu.RLock()
	defer state.ClientsMu.RUnlock()

	// Prepend metadata header: 1 byte sender ID length, then sender name, then audio
	// This helps the receiver's Web Audio API separate streams and mix them smoothly
	senderHeader := []byte(fmt.Sprintf("%s:%s", sender.ID, sender.Name))
	headerLen := byte(len(senderHeader))
	
	packet := make([]byte, 1+int(headerLen)+len(audioData))
	packet[0] = headerLen
	copy(packet[1:1+int(headerLen)], senderHeader)
	copy(packet[1+int(headerLen):], audioData)

	if sender.Role == "Director" {
		// Director is speaking. Route ONLY to chosen targets
		for _, target := range state.Clients {
			if target.Role == "Director" {
				continue
			}
			shouldSend := false
			if state.DirectorAll {
				shouldSend = true
			} else if state.DirectorRoles[target.Role] {
				shouldSend = true
			} else if state.DirectorTargets[target.ID] {
				shouldSend = true
			}

			if shouldSend {
				select {
				case target.Send <- packet:
				default:
					// Drop packet if client buffer is congested
				}
			}
		}
	} else {
		// Crew member is speaking.
		// Rule 1: Always forward crew voice to the Director
		for _, target := range state.Clients {
			if target.Role == "Director" {
				select {
				case target.Send <- packet:
				default:
				}
			}
		}

		// Rule 2: If "Clients Hear Each Other" is enabled, forward to other clients of the SAME role
		if state.ClientsHearEachOther {
			for _, target := range state.Clients {
				if target.ID == sender.ID || target.Role == "Director" {
					continue
				}
				// Route to same role or broadcast to everyone
				if target.Role == sender.Role {
					select {
					case target.Send <- packet:
					default:
					}
				}
			}
		}
	}
}

// handleJSONCommand processes control messages like pings, mutes, and routing configs
func handleJSONCommand(client *Client, data []byte) {
	var cmd map[string]interface{}
	if err := json.Unmarshal(data, &cmd); err != nil {
		return
	}

	cmdType, ok := cmd["type"].(string)
	if !ok {
		return
	}

	switch cmdType {
	case "ping":
		// Send pong back immediately to calculate latency
		ts, _ := cmd["timestamp"]
		pong, _ := json.Marshal(map[string]interface{}{
			"type":      "pong",
			"timestamp": ts,
		})
		_ = client.Conn.WriteMessage(websocket.TextMessage, pong)

	case "latency":
		// Client reports its computed RTT latency
		if lat, ok := cmd["rtt"].(float64); ok {
			client.Latency = int(lat)
			// Map RTT to visual status state
			if client.Latency < 35 {
				client.Status = "Excellent"
			} else if client.Latency < 100 {
				client.Status = "Good"
			} else if client.Latency < 250 {
				client.Status = "Unstable"
			} else {
				client.Status = "OutOfRange"
			}
			broadcastStatus()
		}

	case "set_targets":
		// Director configures routing matrix
		if client.Role != "Director" {
			return
		}
		state.ClientsMu.Lock()
		// Clear previous rules
		state.DirectorTargets = make(map[string]bool)
		state.DirectorRoles = make(map[string]bool)
		state.DirectorAll = false

		if all, ok := cmd["all"].(bool); ok && all {
			state.DirectorAll = true
		} else {
			if roles, ok := cmd["roles"].([]interface{}); ok {
				for _, r := range roles {
					if rStr, ok := r.(string); ok {
						state.DirectorRoles[rStr] = true
					}
				}
			}
			if targets, ok := cmd["targets"].([]interface{}); ok {
				for _, t := range targets {
					if tStr, ok := t.(string); ok {
						state.DirectorTargets[tStr] = true
					}
				}
			}
		}

		if hear, ok := cmd["hear_each_other"].(bool); ok {
			state.ClientsHearEachOther = hear
		}
		state.ClientsMu.Unlock()
		broadcastStatus()

	case "mute_client":
		// Director mutes/unmutes a photographer
		if client.Role != "Director" {
			return
		}
		targetID, _ := cmd["id"].(string)
		muteState, _ := cmd["muted"].(bool)

		state.ClientsMu.Lock()
		if target, exists := state.Clients[targetID]; exists {
			target.Muted = muteState
			// Send a control command directly to the client to let them know they are muted
			muteAlert, _ := json.Marshal(map[string]interface{}{
				"type":  "mute_update",
				"muted": muteState,
			})
			_ = target.Conn.WriteMessage(websocket.TextMessage, muteAlert)
		}
		state.ClientsMu.Unlock()
		broadcastStatus()

	case "regenerate_pin":
		// Director regenerates the daily session PIN
		if client.Role != "Director" {
			return
		}
		state.PIN = fmt.Sprintf("%04d", mrand.IntN(9000)+1000)
		broadcastStatus()

	case "kick_client":
		// Director kicks out a client
		if client.Role != "Director" {
			return
		}
		targetID, _ := cmd["id"].(string)
		state.ClientsMu.Lock()
		if target, exists := state.Clients[targetID]; exists {
			kickMsg, _ := json.Marshal(map[string]interface{}{
				"type":    "error",
				"message": "You have been kicked out by the Director.",
			})
			_ = target.Conn.WriteMessage(websocket.TextMessage, kickMsg)
			_ = target.Conn.Close()
		}
		state.ClientsMu.Unlock()
		broadcastStatus()
	}
}

// broadcastStatus compiles the current list of crew members and signals, sending it to the Director
func broadcastStatus() {
	state.ClientsMu.RLock()
	defer state.ClientsMu.RUnlock()

	crewList := make([]*Client, 0)
	for _, c := range state.Clients {
		crewList = append(crewList, c)
	}

	update := map[string]interface{}{
		"type":                   "status",
		"pin":                    state.PIN,
		"clients_hear_each_other": state.ClientsHearEachOther,
		"director_all":           state.DirectorAll,
		"director_roles":         getMapKeys(state.DirectorRoles),
		"director_targets":       getMapKeys(state.DirectorTargets),
		"clients":                crewList,
		"ips":                    detectedIPs,
	}

	updateBytes, err := json.Marshal(update)
	if err != nil {
		return
	}

	// Send status update to all connected Directors
	for _, c := range state.Clients {
		if c.Role == "Director" {
			_ = c.Conn.WriteMessage(websocket.TextMessage, updateBytes)
		}
	}
}

// supervisorLoop checks for connection timeouts (e.g. out of Wi-Fi range)
func supervisorLoop() {
	ticker := time.NewTicker(2 * time.Second)
	for range ticker.C {
		state.ClientsMu.Lock()
		changed := false

		now := time.Now()
		for _, c := range state.Clients {
			if c.Role == "Director" {
				continue
			}

			dur := now.Sub(c.LastSeen)
			if dur > 8*time.Second {
				// Mark as Offline
				if c.Status != "Offline" {
					c.Status = "Offline"
					c.Latency = 9999
					changed = true
					fmt.Printf("[Supervisor] Client %s went Offline (Out of Range)\n", c.Name)
				}
			} else if dur > 4*time.Second {
				// Mark as Out of Range / Reconnecting
				if c.Status != "OutOfRange" {
					c.Status = "OutOfRange"
					c.Latency = 1500
					changed = true
					fmt.Printf("[Supervisor] Client %s experiencing critical signal degradation (Out of Range)\n", c.Name)
				}
			}
		}
		state.ClientsMu.Unlock()

		if changed {
			broadcastStatus()
		}
	}
}

// getLocalIPs queries the local interfaces for valid IPv4 local Wi-Fi addresses
func getLocalIPs() []string {
	var ips []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return []string{"127.0.0.1"}
	}
	for _, iface := range ifaces {
		// Filter out down or loopback interfaces
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip = ip.To4()
			if ip == nil {
				continue
			}
			ips = append(ips, ip.String())
		}
	}
	if len(ips) == 0 {
		return []string{"127.0.0.1"}
	}
	return ips
}

// getMapKeys converts a boolean map to a slice of string keys
func getMapKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			keys = append(keys, k)
		}
	}
	return keys
}

// generateSelfSignedCert creates an in-memory X.509 TLS certificate for the HTTPS server
func generateSelfSignedCert(ips []string) (tls.Certificate, error) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return tls.Certificate{}, err
	}

	notBefore := time.Now()
	notAfter := notBefore.Add(365 * 24 * time.Hour)

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serialNumber, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		return tls.Certificate{}, err
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization:  []string{"Local Intercom"},
			CommonName:    "Local Intercom Server",
			Country:       []string{"EG"},
			Province:      []string{"Cairo"},
			Locality:      []string{"Cairo"},
			StreetAddress: []string{"Local Wi-Fi Network"},
		},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}

	// Add local detected IPs
	for _, ipStr := range ips {
		if ip := net.ParseIP(ipStr); ip != nil {
			template.IPAddresses = append(template.IPAddresses, ip)
		}
	}
	template.IPAddresses = append(template.IPAddresses, net.ParseIP("127.0.0.1"))
	template.DNSNames = append(template.DNSNames, "localhost", "intercom.local")

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, err
	}

	// PEM encode
	var certPEM, keyPEM bytes.Buffer
	err = pem.Encode(&certPEM, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	if err != nil {
		return tls.Certificate{}, err
	}
	err = pem.Encode(&keyPEM, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})
	if err != nil {
		return tls.Certificate{}, err
	}

	return tls.X509KeyPair(certPEM.Bytes(), keyPEM.Bytes())
}
