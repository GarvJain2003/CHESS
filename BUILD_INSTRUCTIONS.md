# Build Instructions

## Building for Windows

To build the application for Windows (x64), run the following command:

```bash
npm run electron:build:win
```

The output installer will be located at:
`dist-electron/Smart Chess Setup 0.0.0.exe`

### Note on Code Signing
The generated installer is not code-signed. Windows SmartScreen may warn users when trying to run it. Users can bypass this by clicking "More info" and then "Run anyway".

## Building for macOS

To build for macOS, run:

```bash
npm run electron:build
```
