package com.seekerclaw.app.qr

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.seekerclaw.app.ui.theme.SeekerClawTheme
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class QrScannerActivity : ComponentActivity() {
    companion object {
        const val EXTRA_QR_TEXT = "qr_text"
        const val EXTRA_ERROR = "qr_error"
        private const val TAG = "QrScannerActivity"
    }

    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private val processingFrame = AtomicBoolean(false)

    private var hasResult = false
    private var cameraProvider: ProcessCameraProvider? = null
    private var imageAnalysis: ImageAnalysis? = null
    private var camera: Camera? = null

    private val scanner = BarcodeScanning.getClient(
        BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
    )

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (!granted) {
            finishWithError("Camera permission is required to scan config QR")
        }
        // If granted, the Compose UI will start the camera via DisposableEffect
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }

        setContent {
            SeekerClawTheme {
                QrScannerContent(
                    onQrDetected = { raw ->
                        if (!hasResult) {
                            hasResult = true
                            imageAnalysis?.clearAnalyzer()
                            setResult(
                                Activity.RESULT_OK,
                                Intent().putExtra(EXTRA_QR_TEXT, raw)
                            )
                            finish()
                        }
                    },
                    onCancel = { finishCancelled() },
                )
            }
        }
    }

    @Composable
    private fun QrScannerContent(
        onQrDetected: (String) -> Unit,
        onCancel: () -> Unit,
    ) {
        val context = LocalContext.current
        val lifecycleOwner = LocalLifecycleOwner.current

        var torchAvailable by remember { mutableStateOf(false) }
        var torchEnabled by remember { mutableStateOf(false) }
        var isDetected by remember { mutableStateOf(false) }

        val previewView = remember {
            PreviewView(context).apply {
                implementationMode = PreviewView.ImplementationMode.PERFORMANCE
            }
        }

        // Camera lifecycle management
        DisposableEffect(lifecycleOwner) {
            val hasPerm = ContextCompat.checkSelfPermission(
                context, Manifest.permission.CAMERA
            ) == PackageManager.PERMISSION_GRANTED

            if (hasPerm) {
                val providerFuture = ProcessCameraProvider.getInstance(context)
                providerFuture.addListener({
                    try {
                        val provider = providerFuture.get()
                        cameraProvider = provider

                        val preview = Preview.Builder().build().also {
                            it.surfaceProvider = previewView.surfaceProvider
                        }

                        val analysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .setImageQueueDepth(1)
                            .build()

                        analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                            val mediaImage = imageProxy.image
                            if (mediaImage == null || hasResult) {
                                imageProxy.close()
                                return@setAnalyzer
                            }
                            if (!processingFrame.compareAndSet(false, true)) {
                                imageProxy.close()
                                return@setAnalyzer
                            }

                            val input = InputImage.fromMediaImage(
                                mediaImage, imageProxy.imageInfo.rotationDegrees
                            )
                            scanner.process(input)
                                .addOnSuccessListener { barcodes ->
                                    if (hasResult) return@addOnSuccessListener
                                    val raw = barcodes.firstNotNullOfOrNull {
                                        it.rawValue?.trim()
                                    }
                                    if (!raw.isNullOrBlank()) {
                                        isDetected = true
                                        onQrDetected(raw)
                                    }
                                }
                                .addOnFailureListener { e ->
                                    Log.w(TAG, "QR scan frame failed: ${e.message}")
                                }
                                .addOnCompleteListener {
                                    processingFrame.set(false)
                                    imageProxy.close()
                                }
                        }

                        imageAnalysis = analysis
                        provider.unbindAll()
                        camera = provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis
                        )

                        torchAvailable = camera?.cameraInfo?.hasFlashUnit() == true
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to start camera", e)
                    }
                }, ContextCompat.getMainExecutor(context))
            }

            onDispose {
                runCatching { cameraProvider?.unbindAll() }
            }
        }

        // UI layers
        Box(modifier = Modifier.fillMaxSize()) {
            // Layer 0: Camera preview
            AndroidView(
                factory = { previewView },
                modifier = Modifier.fillMaxSize(),
            )

            // Layer 1: Themed overlay
            ScannerOverlay(
                torchAvailable = torchAvailable,
                torchEnabled = torchEnabled,
                isDetected = isDetected,
                onToggleTorch = {
                    val cam = camera ?: return@ScannerOverlay
                    if (cam.cameraInfo.hasFlashUnit() != true) return@ScannerOverlay
                    torchEnabled = !torchEnabled
                    cam.cameraControl.enableTorch(torchEnabled)
                },
                onCancel = onCancel,
            )
        }
    }

    private fun finishCancelled() {
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    private fun finishWithError(message: String) {
        setResult(
            Activity.RESULT_CANCELED,
            Intent().putExtra(EXTRA_ERROR, message)
        )
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { imageAnalysis?.clearAnalyzer() }
        runCatching { cameraProvider?.unbindAll() }
        runCatching { scanner.close() }
        cameraExecutor.shutdown()
    }
}
