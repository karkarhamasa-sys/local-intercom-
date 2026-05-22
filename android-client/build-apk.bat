@echo off
rem Set JAVA_HOME to the installed JDK
set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"

rem Add JDK bin to PATH for this session
set "PATH=%JAVA_HOME%\bin;%PATH%"

rem Change to project directory
cd /d "e:\free intercome\android-client"

rem Execute Gradle wrapper to assemble debug APK
call .\gradlew.bat assembleDebug

if %ERRORLEVEL% neq 0 (
  echo ==============================
  echo ERROR: Build failed with exit code %ERRORLEVEL%
  exit /b %ERRORLEVEL%
) else (
  echo ==============================
  echo Build succeeded! APK is located under app\build\outputs\apk\debug
)
