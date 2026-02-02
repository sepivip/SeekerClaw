#include <jni.h>
#include <string>
#include <cstdlib>
#include "node.h"
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

// Redirect stdout/stderr to logcat
int pipe_stdout[2];
int pipe_stderr[2];
pthread_t thread_stdout;
pthread_t thread_stderr;
const char *ADBTAG = "SEEKERCLAW-NODE";

void *thread_stderr_func(void*) {
    ssize_t redirect_size;
    char buf[2048];
    while((redirect_size = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
        if(buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, buf);
    }
    return 0;
}

void *thread_stdout_func(void*) {
    ssize_t redirect_size;
    char buf[2048];
    while((redirect_size = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
        if(buf[redirect_size - 1] == '\n') --redirect_size;
        buf[redirect_size] = 0;
        __android_log_write(ANDROID_LOG_INFO, ADBTAG, buf);
    }
    return 0;
}

int start_redirecting_stdout_stderr() {
    setvbuf(stdout, 0, _IONBF, 0);
    pipe(pipe_stdout);
    dup2(pipe_stdout[1], STDOUT_FILENO);

    setvbuf(stderr, 0, _IONBF, 0);
    pipe(pipe_stderr);
    dup2(pipe_stderr[1], STDERR_FILENO);

    if(pthread_create(&thread_stdout, 0, thread_stdout_func, 0) == -1) return -1;
    pthread_detach(thread_stdout);
    if(pthread_create(&thread_stderr, 0, thread_stderr_func, 0) == -1) return -1;
    pthread_detach(thread_stderr);
    return 0;
}

// JNI function — called from Kotlin NodeBridge.startNodeWithArguments()
// Package path: com.seekerclaw.app.service.NodeBridge
extern "C" jint JNICALL
Java_com_seekerclaw_app_service_NodeBridge_startNodeWithArguments(
        JNIEnv *env,
        jobject /* this */,
        jobjectArray arguments) {

    jsize argument_count = env->GetArrayLength(arguments);

    int c_arguments_size = 0;
    for (int i = 0; i < argument_count; i++) {
        c_arguments_size += strlen(env->GetStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), 0));
        c_arguments_size++;
    }

    char* args_buffer = (char*)calloc(c_arguments_size, sizeof(char));
    char* argv[argument_count];
    char* current_args_position = args_buffer;

    for (int i = 0; i < argument_count; i++) {
        const char* current_argument = env->GetStringUTFChars((jstring)env->GetObjectArrayElement(arguments, i), 0);
        strncpy(current_args_position, current_argument, strlen(current_argument));
        argv[i] = current_args_position;
        current_args_position += strlen(current_args_position) + 1;
    }

    if (start_redirecting_stdout_stderr() == -1) {
        __android_log_write(ANDROID_LOG_ERROR, ADBTAG, "Couldn't start redirecting stdout and stderr to logcat.");
    }

    // Log arguments before starting
    for (int i = 0; i < argument_count; i++) {
        char logbuf[512];
        snprintf(logbuf, sizeof(logbuf), "argv[%d] = %s", i, argv[i]);
        __android_log_write(ANDROID_LOG_INFO, ADBTAG, logbuf);
    }
    __android_log_write(ANDROID_LOG_INFO, ADBTAG, "Calling node::Start()...");

    int exitCode = node::Start(argument_count, argv);

    char exitBuf[64];
    snprintf(exitBuf, sizeof(exitBuf), "node::Start() returned with code: %d", exitCode);
    __android_log_write(ANDROID_LOG_INFO, ADBTAG, exitBuf);

    return jint(exitCode);
}
