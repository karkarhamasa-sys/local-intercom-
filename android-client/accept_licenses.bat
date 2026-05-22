@echo off
rem Set JDK path
set "JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot"
rem Add JDK bin to PATH
set "PATH=%JAVA_HOME%\bin;%PATH%"
rem Automatically accept all SDK licenses
(echo y) | "%USERPROFILE%\AppData\Local\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses
