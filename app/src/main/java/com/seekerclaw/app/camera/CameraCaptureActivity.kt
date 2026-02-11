package com.seekerclaw.app.camera

import android.Manifest
import android.app.KeyguardManager
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.io.File

/**
 * One-shot camera capture activity.
 * Triggered by AndroidBridge and reports results through files for cross-process reliability.
 */
class CameraCaptureActivity : ComponentActivity() {
    companion object {
        private const val TAG = "CameraCapture"
        const val RESULTS_DIR = "camera_results"
        const val CAPTURES_DIR = "camera_captures"
    }

    private var requestId: String = ""
    private var lens: String = "back"
    private lateinit var previewView: PreviewView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestId = intent.getStringExtra("requestId") ?: ""
        lens = intent.getStringExtra("lens")?.lowercase() ?: "back"

        if (requestId.isBlank()) {
            Log.e(TAG, "Missing requestId")
            finish()
            return
        }

        // Workaround for "device as server": wake screen and try to dismiss keyguard for capture.
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val keyguardManager = getSystemService(KeyguardManager::class.java)
        keyguardManager?.requestDismissKeyguard(this, null)

        previewView = PreviewView(this).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
        setContentView(previewView)

        if (!hasCameraPermission()) {
            writeResultFile(
                JSONObject().apply {
                    put("error", "CAMERA permission not granted")
                }
            )
            finish()
            return
        }

        startCameraAndCapture()
    }

    private fun hasCameraPermission(): Boolean {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun startCameraAndCapture() {
        val lensFacing = if (lens == "front") {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }

        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            try {
                val cameraProvider = cameraProviderFuture.get()
                val preview = Preview.Builder().build().also {
                    it.surfaceProvider = previewView.surfaceProvider
                }
                val imageCapture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setJpegQuality(80)
                    .build()
                val cameraSelector = CameraSelector.Builder()
                    .requireLensFacing(lensFacing)
                    .build()

                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(this, cameraSelector, preview, imageCapture)

                // Give camera pipeline a moment to warm up before capture.
                previewView.postDelayed({ capturePhoto(imageCapture) }, 600)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start camera", e)
                writeResultFile(
                    JSONObject().apply {
                        put("error", "Failed to start camera: ${e.message}")
                    }
                )
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun capturePhoto(imageCapture: ImageCapture) {
        val captureDir = File(filesDir, CAPTURES_DIR).apply { mkdirs() }
        pruneOldCaptures(captureDir)
        val outputFile = File(captureDir, "$requestId.jpg")

        val outputOptions = ImageCapture.OutputFileOptions.Builder(outputFile).build()
        imageCapture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    writeResultFile(
                        JSONObject().apply {
                            put("success", true)
                            put("path", outputFile.absolutePath)
                            put("lens", lens)
                            put("capturedAt", System.currentTimeMillis())
                        }
                    )
                    finish()
                }

                override fun onError(exception: ImageCaptureException) {
                    Log.e(TAG, "Capture failed", exception)
                    writeResultFile(
                        JSONObject().apply {
                            put("error", "Capture failed: ${exception.message}")
                        }
                    )
                    finish()
                }
            }
        )
    }

    private fun pruneOldCaptures(captureDir: File) {
        val files = captureDir.listFiles()?.sortedByDescending { it.lastModified() } ?: return
        files.drop(50).forEach { file ->
            runCatching { file.delete() }
        }
    }

    private fun writeResultFile(result: JSONObject) {
        val resultDir = File(filesDir, RESULTS_DIR).apply { mkdirs() }
        val tmpFile = File(resultDir, "$requestId.tmp")
        val jsonFile = File(resultDir, "$requestId.json")
        tmpFile.writeText(result.toString())
        tmpFile.renameTo(jsonFile)
        Log.d(TAG, "Camera result written: ${jsonFile.absolutePath}")
    }
}
