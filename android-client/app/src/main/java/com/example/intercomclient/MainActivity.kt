package com.example.intercomclient

import android.Manifest
import android.content.pm.PackageManager
import android.net.http.SslError
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import android.view.ViewGroup

import com.example.intercomclient.theme.IntercomClientTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            IntercomClientTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = Color(0xFF0F0C1B) // Sleek Premium Dark Background
                ) {
                    IntercomAppScreen()
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IntercomAppScreen() {
    val context = LocalContext.current
    
    // Connection Settings States
    var ip by remember { mutableStateOf("192.168.1.15") }
    var port by remember { mutableStateOf("8443") }
    var name by remember { mutableStateOf("مصور 1") }
    var pin by remember { mutableStateOf("") }
    
    var isConnected by remember { mutableStateOf(false) }
    var hasMicPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    // Permission Launcher
    val requestPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted: Boolean ->
        hasMicPermission = isGranted
    }

    // Handle physical back button to disconnect and return to form
    if (isConnected) {
        BackHandler {
            isConnected = false
        }
    }

    if (isConnected) {
        // Show Fullscreen WebClient connecting to the local Go server
        val webUrl = "https://$ip:$port/?name=$name&pin=$pin&role=Photographer"
        
        Box(modifier = Modifier.fillMaxSize().background(Color(0xFF0F0C1B))) {
            AndroidView(
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT
                        )
                        
                        settings.apply {
                            javaScriptEnabled = true
                            domStorageEnabled = true
                            mediaPlaybackRequiresUserGesture = false
                            cacheMode = WebSettings.LOAD_NO_CACHE
                            useWideViewPort = true
                            loadWithOverviewMode = true
                            userAgentString = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 IntercomClient/1.0"
                        }

                        // Override SSL verification and permission models
                        webViewClient = object : WebViewClient() {
                            override fun onReceivedSslError(
                                view: WebView?,
                                handler: SslErrorHandler?,
                                error: SslError?
                            ) {
                                // CRITICAL: Proceed past dynamic self-signed certificate warnings!
                                handler?.proceed()
                            }
                        }

                        webChromeClient = object : WebChromeClient() {
                            override fun onPermissionRequest(request: PermissionRequest?) {
                                // CRITICAL: Auto-grant microphone audio capture permissions!
                                request?.grant(request.resources)
                            }
                        }

                        loadUrl(webUrl)
                    }
                },
                modifier = Modifier.fillMaxSize()
            )

            // Floating back button to return to settings
            Button(
                onClick = { isConnected = false },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xD9FF1744)),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("🔴 إنهاء الاتصال والعودة", color = Color.White, fontWeight = FontWeight.Bold)
            }
        }
    } else {
        // Show Connection settings Form with custom Glassmorphism/Dark Styling
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp)
                .safeDrawingPadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // App Title/Logo
            Text(
                text = "🎙️ انتركم المصورين",
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                color = Color.White,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 8.dp)
            )
            
            Text(
                text = "نظام الاتصال الداخلي لغرفة التحكم والمخرج أوفلاين",
                fontSize = 13.sp,
                color = Color(0xFFA099C0),
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(bottom = 32.dp)
            )

            // Form container
            Card(
                colors = CardDefaults.cardColors(containerColor = Color(0x15FFFFFF)),
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 24.dp)
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    Text(
                        text = "بيانات الاتصال بالشبكة المحلية",
                        fontSize = 15.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color(0xFF00E5FF)
                    )

                    // IP Field
                    OutlinedTextField(
                        value = ip,
                        onValueChange = { ip = it },
                        label = { Text("عنوان IP اللابتوب (الخادم)", color = Color(0xFFA099C0)) },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFF00E5FF),
                            unfocusedBorderColor = Color(0x33FFFFFF),
                            focusedLabelColor = Color(0xFF00E5FF),
                            focusedTextColor = Color.White,
                            unfocusedTextColor = Color.White
                        ),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        // Port Field
                        OutlinedTextField(
                            value = port,
                            onValueChange = { port = it },
                            label = { Text("المنفذ", color = Color(0xFFA099C0)) },
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFF00E5FF),
                                unfocusedBorderColor = Color(0x33FFFFFF),
                                focusedLabelColor = Color(0xFF00E5FF),
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            ),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )

                        // PIN Field
                        OutlinedTextField(
                            value = pin,
                            onValueChange = { pin = it },
                            label = { Text("رمز الجلسة", color = Color(0xFF00E5FF)) },
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = Color(0xFF00E5FF),
                                unfocusedBorderColor = Color(0xFF00E5FF),
                                focusedLabelColor = Color(0xFF00E5FF),
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            ),
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            singleLine = true,
                            placeholder = { Text("رمز اليوم", color = Color(0x55FFFFFF)) },
                            modifier = Modifier.weight(1.2f)
                        )
                    }

                    // Name Field
                    OutlinedTextField(
                        value = name,
                        onValueChange = { name = it },
                        label = { Text("اسم المصور / الكاميرا", color = Color(0xFFA099C0)) },
                        colors = OutlinedTextFieldDefaults.colors(
                            focusedBorderColor = Color(0xFF00E5FF),
                            unfocusedBorderColor = Color(0x33FFFFFF),
                            focusedLabelColor = Color(0xFF00E5FF),
                            focusedTextColor = Color.White,
                            unfocusedTextColor = Color.White
                        ),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            // Permissions / Connectivity state visualizer
            if (!hasMicPermission) {
                Button(
                    onClick = { requestPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO) },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFFFB300)),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 16.dp)
                ) {
                    Text("🎙️ اضغط هنا للموافقة على صلاحية المايك", color = Color(0xFF0F0C1B), fontWeight = FontWeight.Bold)
                }
            } else {
                Card(
                    colors = CardDefaults.cardColors(containerColor = Color(0x1000E676)),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 16.dp)
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center
                    ) {
                        Text("✅ صلاحية الميكروفون مقبولة وجاهزة", color = Color(0xFF00E676), fontSize = 13.sp)
                    }
                }
            }

            // Connection Trigger Button
            Button(
                onClick = {
                    if (!hasMicPermission) {
                        requestPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    } else if (ip.isNotBlank() && port.isNotBlank() && name.isNotBlank() && pin.isNotBlank()) {
                        isConnected = true
                    }
                },
                enabled = ip.isNotBlank() && port.isNotBlank() && name.isNotBlank() && pin.isNotBlank(),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = Color(0xFF00E5FF),
                    disabledContainerColor = Color(0x3300E5FF)
                ),
                shape = RoundedCornerShape(14.dp)
            ) {
                Text(
                    text = if (hasMicPermission) "🔌 اتصل الآن بالبث الجماعي" else "🎙️ تفعيل المايك أولاً للاتصال",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    color = if (ip.isNotBlank() && port.isNotBlank() && name.isNotBlank() && pin.isNotBlank()) Color(0xFF0F0C1B) else Color(0x66FFFFFF)
                )
            }
        }
    }
}

// Custom ViewGroup.LayoutParams imports container helper inside view factory
// We add standard android imports dynamically via layout parameters

