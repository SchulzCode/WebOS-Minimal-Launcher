// Minimal Home boot splash (tld.my.bootsplash): a tiny NATIVE app the TV starts first at a cold boot.
//
// Why: at a cold boot LG's web runtime (WebAppMgr) only gets the launcher's page on screen ~16 s after the panel comes on,
// which was a black screen. Native apps don't go through the web runtime, so this one can draw at once. It asks the app
// manager to preload Minimal Home right away, draws the launcher's splash - its background and wash, the clock mark with
// turning hands, the name - and quits as soon as Minimal Home covers it (or after MAX_SHOW_S as a safety net).
// After a wake from standby (the TV has been up for a while) it only launches Minimal Home and quits without drawing.
//
// The picture is splash/splash.html (?app=bootsplash) drawn natively: keep the layout numbers below in step with it.
// The helper service (app/service/service.js) points general.physicalLastInputApp - the app the boot manager starts -
// at this app while it is installed. Everything else (HOME, Back, wake) still goes straight to Minimal Home.
//
// LG's libraries (SDL2, GLESv2, libpng) are loaded at run time with dlopen, so building needs only zig - no TV sysroot.
// Build + package: bootsplash/build.sh.
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAIN_APP "tld.my.minimalhome"
#define LOG_PATH "/tmp/bootsplash.log"
#define WORDMARK "wordmark.png"      // the name, white on black (build.sh), next to the binary = working directory
#define W 1920
#define H 1080
#define WAKE_UPTIME_S 150.0          // up longer than this = woken from standby, not a cold boot: no splash
#define MAX_SHOW_S 90.0              // never stay in front longer than this
#define RELAUNCH_EVERY_S 2.0         // repeat the launch while still in front: one that lands before this window shows leaves
                                     // the launcher behind it; a repeat only wakes the launcher page (cheap)
#define TEST_S 8.0                   // {"test":true}: how long the splash stays up
// where build.sh found the wordmark in the full-screen render (top-left corner; its size comes from the PNG)
#ifndef WM_X
#define WM_X 858
#endif
#ifndef WM_Y
#define WM_Y 571
#endif

static FILE *logfp;
static double uptime(void) {
	double u = 0; FILE *f = fopen("/proc/uptime", "r");
	if (f) { if (fscanf(f, "%lf", &u) != 1) u = 0; fclose(f); }
	return u;
}
static void logmsg(const char *fmt, ...) {
	if (!logfp) return;
	va_list ap; va_start(ap, fmt);
	fprintf(logfp, "[up=%.2f] ", uptime()); vfprintf(logfp, fmt, ap); fputc('\n', logfp); fflush(logfp);
	va_end(ap);
}
static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }

// Ask the app manager to start Minimal Home. Jailed native dev apps only get the "public" bus permissions, which can't
// launch apps; luna-send-pub runs with the developer-tools role (what ares-launch uses), which can.
// The first request is a PRELOAD (what LG's preload manager does at boot): the web runtime starts loading the page hidden
// right away, while plain launches made this early are only acted on once the system has finished booting (~38 s).
// Later requests are plain launches that bring the page to the front once it is ready. Both are noSplash like the boot
// manager's own launch: otherwise the app manager puts LG's launch screen for Minimal Home over this one.
// Fire and forget: the child is reaped automatically (SIGCHLD ignored) and killed by timeout if the bus hangs. The TV kills
// an app's children when the app exits, so every exit path waits for the request first (finish_launches).
static void launch_main(const char *why, int preload) {
	pid_t p = fork();
	if (p == 0) {
		signal(SIGCHLD, SIG_DFL);  // an ignored SIGCHLD would be inherited and break timeout's wait for luna-send-pub
		unsetenv("LD_PRELOAD");   // the app jail sets it to the literal string '$LD_PRELOAD' (harmless, but noisy)
		int in = open("/dev/null", O_RDONLY), out = open(LOG_PATH, O_WRONLY | O_APPEND | O_CREAT, 0600);
		if (in >= 0) dup2(in, 0);
		if (out >= 0) { dup2(out, 1); dup2(out, 2); }
		execl("/usr/bin/timeout", "timeout", "10", "/usr/bin/luna-send-pub", "-n", "1", "luna://com.webos.applicationManager/launch",
			preload ? "{\"id\":\"" MAIN_APP "\",\"noSplash\":true,\"preload\":\"full\"}" : "{\"id\":\"" MAIN_APP "\",\"noSplash\":true}",
			(char *)NULL);
		perror("exec luna-send-pub");
		_exit(127);
	}
	logmsg("%s %s (%s): %s", preload ? "preload" : "launch", MAIN_APP, why, p > 0 ? "requested" : "fork failed");
}
// with SIGCHLD ignored, wait() blocks until every child has finished and then fails with ECHILD
static void finish_launches(void) { while (wait(NULL) > 0) {} }

// ---- the few SDL2 / GLES2 / libpng entry points used (LG's SDL 2.0.14 fork, loaded at run time) ----
#define SDL_INIT_VIDEO 0x20u
#define SDL_INIT_EVENTS 0x4000u
#define SDL_WINDOW_FULLSCREEN 0x1u
#define SDL_WINDOW_OPENGL 0x2u
#define SDL_QUIT 0x100u
#define SDL_APP_WILLENTERBACKGROUND 0x103u
#define SDL_APP_DIDENTERBACKGROUND 0x104u
#define SDL_WINDOWEVENT 0x200u
#define SDL_WINDOWEVENT_HIDDEN 2
#define SDL_WINDOWEVENT_MINIMIZED 7
typedef union { uint32_t type; struct { uint32_t type, ts, win; uint8_t event; } window; uint8_t pad[56]; } SDL_Event;

static int (*SDL_Init)(uint32_t);
static int (*SDL_GL_SetAttribute)(int, int);
static void *(*SDL_CreateWindow)(const char *, int, int, int, int, uint32_t);
static void *(*SDL_GL_CreateContext)(void *);
static int (*SDL_GL_SetSwapInterval)(int);
static void (*SDL_GL_SwapWindow)(void *);
static int (*SDL_PollEvent)(SDL_Event *);
static const char *(*SDL_GetError)(void);

typedef unsigned int GLuint; typedef int GLint; typedef unsigned int GLenum; typedef float GLfloat; typedef int GLsizei; typedef char GLchar;
#define GL_TRIANGLE_STRIP 0x0005
#define GL_COLOR_BUFFER_BIT 0x4000
#define GL_TEXTURE_2D 0x0DE1
#define GL_UNPACK_ALIGNMENT 0x0CF5
#define GL_UNSIGNED_BYTE 0x1401
#define GL_FLOAT 0x1406
#define GL_LUMINANCE 0x1909
#define GL_NEAREST 0x2600
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_LINEAR 0x2601
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_VERTEX_SHADER 0x8B31
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
static void (*glViewport)(GLint, GLint, GLsizei, GLsizei);
static void (*glClearColor)(GLfloat, GLfloat, GLfloat, GLfloat);
static void (*glClear)(GLenum);
static GLuint (*glCreateShader)(GLenum);
static void (*glShaderSource)(GLuint, GLsizei, const GLchar *const *, const GLint *);
static void (*glCompileShader)(GLuint);
static void (*glGetShaderiv)(GLuint, GLenum, GLint *);
static void (*glGetShaderInfoLog)(GLuint, GLsizei, GLsizei *, GLchar *);
static GLuint (*glCreateProgram)(void);
static void (*glAttachShader)(GLuint, GLuint);
static void (*glBindAttribLocation)(GLuint, GLuint, const GLchar *);
static void (*glLinkProgram)(GLuint);
static void (*glGetProgramiv)(GLuint, GLenum, GLint *);
static void (*glUseProgram)(GLuint);
static GLint (*glGetUniformLocation)(GLuint, const GLchar *);
static void (*glUniform1f)(GLint, GLfloat);
static void (*glUniform2f)(GLint, GLfloat, GLfloat);
static void (*glUniform1i)(GLint, GLint);
static void (*glGenTextures)(GLsizei, GLuint *);
static void (*glBindTexture)(GLenum, GLuint);
static void (*glTexParameteri)(GLenum, GLenum, GLint);
static void (*glPixelStorei)(GLenum, GLint);
static void (*glTexImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *);
static void (*glVertexAttribPointer)(GLuint, GLint, GLenum, unsigned char, GLsizei, const void *);
static void (*glEnableVertexAttribArray)(GLuint);
static void (*glDrawArrays)(GLenum, GLint, GLsizei);

// libpng 1.6 "simplified API"
typedef struct { void *opaque; uint32_t version, width, height, format, flags, colormap_entries, warning_or_error; char message[64]; } png_image;
#define PNG_IMAGE_VERSION 1
#define PNG_FORMAT_GRAY 0
static int (*png_image_begin_read_from_file)(png_image *, const char *);
static int (*png_image_finish_read)(png_image *, const void *, void *, int32_t, void *);
static void (*png_image_free)(png_image *);

#define SYM(lib, name) do { *(void **)&name = dlsym(lib, #name); if (!name) { logmsg("missing symbol %s", #name); return 0; } } while (0)
static int load_libs(void) {
	void *sdl = dlopen("libSDL2-2.0.so.0", RTLD_NOW | RTLD_GLOBAL);
	void *gl = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_GLOBAL);
	if (!sdl || !gl) { logmsg("dlopen: %s", dlerror()); return 0; }
	SYM(sdl, SDL_Init); SYM(sdl, SDL_GL_SetAttribute); SYM(sdl, SDL_CreateWindow); SYM(sdl, SDL_GL_CreateContext);
	SYM(sdl, SDL_GL_SetSwapInterval); SYM(sdl, SDL_GL_SwapWindow); SYM(sdl, SDL_PollEvent); SYM(sdl, SDL_GetError);
	SYM(gl, glViewport); SYM(gl, glClearColor); SYM(gl, glClear); SYM(gl, glCreateShader); SYM(gl, glShaderSource);
	SYM(gl, glCompileShader); SYM(gl, glGetShaderiv); SYM(gl, glGetShaderInfoLog); SYM(gl, glCreateProgram);
	SYM(gl, glAttachShader); SYM(gl, glBindAttribLocation); SYM(gl, glLinkProgram); SYM(gl, glGetProgramiv);
	SYM(gl, glUseProgram); SYM(gl, glGetUniformLocation); SYM(gl, glUniform1f); SYM(gl, glUniform2f); SYM(gl, glUniform1i);
	SYM(gl, glGenTextures); SYM(gl, glBindTexture); SYM(gl, glTexParameteri); SYM(gl, glPixelStorei);
	SYM(gl, glTexImage2D); SYM(gl, glVertexAttribPointer); SYM(gl, glEnableVertexAttribArray); SYM(gl, glDrawArrays);
	return 1;
}
// The wordmark, 8-bit grey. libpng is optional: without it the splash just has no name under the mark.
static unsigned char *load_wordmark(int *w, int *h) {
	void *png = dlopen("libpng16.so.16", RTLD_NOW);
	if (!png) { logmsg("no libpng: %s", dlerror()); return NULL; }
	*(void **)&png_image_begin_read_from_file = dlsym(png, "png_image_begin_read_from_file");
	*(void **)&png_image_finish_read = dlsym(png, "png_image_finish_read");
	*(void **)&png_image_free = dlsym(png, "png_image_free");
	if (!png_image_begin_read_from_file || !png_image_finish_read || !png_image_free) { logmsg("libpng: symbols missing"); return NULL; }
	png_image img; memset(&img, 0, sizeof img); img.version = PNG_IMAGE_VERSION;
	if (!png_image_begin_read_from_file(&img, WORDMARK)) { logmsg("png: %s", img.message); return NULL; }
	img.format = PNG_FORMAT_GRAY;
	unsigned char *px = malloc((size_t)img.width * img.height);
	if (!px || !png_image_finish_read(&img, NULL, px, (int32_t)img.width, NULL)) { logmsg("png decode: %s", img.message); free(px); png_image_free(&img); return NULL; }
	*w = (int)img.width; *h = (int)img.height;
	return px;
}

static const char *VS =
	"attribute vec2 pos;\n"
	"void main() { gl_Position = vec4(pos, 0.0, 1.0); }\n";
// splash/splash.html, drawn per pixel (screen pixels, y down):
//  - background #07080c with the launcher's two radial washes (same ellipses and stops as its CSS), dithered so the dark
//    gradients don't band on the OLED;
//  - the clock mark: 96 px box centred at 960,484 (viewBox 100 -> x0.96): ring r44 / stroke 4.2, minute hand (accent) of
//    length 28, hour hand to (14,10), both stroke 5 with round caps. Hands turn: minute once per MIN_REV s, hour 12x slower,
//    easing in from standstill so the first frame is exactly the static mark;
//  - the name from the wordmark texture, rising 6 px into place.
// Entrance: everything fades in over ~0.7 s, the mark from 94 % scale, the name 0.15 s later.
static const char *FS =
	"#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n"
	"uniform float t;\n"
	"uniform sampler2D wm; uniform vec2 wmPos; uniform vec2 wmSize; uniform float hasWm;\n"
	"const vec3 BG = vec3(7.0, 8.0, 12.0) / 255.0;\n"
	"const vec3 TEXT = vec3(243.0, 245.0, 249.0) / 255.0;\n"
	"const vec3 ACCENT = vec3(169.0, 155.0, 255.0) / 255.0;\n"
	"const float MIN_REV = 2.4;\n"
	"float ease(float x) { x = clamp(x, 0.0, 1.0); return 1.0 - pow(1.0 - x, 3.0); }\n"
	"vec3 wash(vec3 c, vec2 p, vec2 at, vec2 r, vec3 col, float a) {\n"
	"  float d = length((p - at) / r) / 0.7;\n"
	"  return mix(c, col, a * (1.0 - clamp(d, 0.0, 1.0)));\n"
	"}\n"
	"float seg(vec2 p, vec2 b) { float h = clamp(dot(p, b) / dot(b, b), 0.0, 1.0); return length(p - b * h); }\n"
	"vec2 rot(vec2 v, float a) { float s = sin(a), c = cos(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }\n"
	"void main() {\n"
	"  vec2 p = vec2(gl_FragCoord.x, 1080.0 - gl_FragCoord.y);\n"
	"  vec3 c = BG;\n"
	"  c = wash(c, p, vec2(1920.0, 1080.0), vec2(900.0, 600.0), vec3(70.0, 120.0, 255.0) / 255.0, 0.07);\n"
	"  c = wash(c, p, vec2(230.4, -86.4), vec2(1100.0, 700.0), vec3(120.0, 104.0, 255.0) / 255.0, 0.16);\n"
	"  float e = ease(t / 0.7);\n"
	"  float k = 0.96 * (0.94 + 0.06 * e);\n"
	"  vec2 q = (p - vec2(960.0, 484.0)) / k;\n"                     // mark space: viewBox units around the centre
	"  float px = 1.0 / k;\n"                                         // one screen pixel in mark units (anti-aliasing)
	"  float ring = abs(length(q) - 44.0) - 2.1;\n"
	"  float spin = t - 0.6 * (1.0 - exp(-t / 0.6));\n"             // starts at rest, reaches full speed smoothly
	"  float am = 6.2831853 * spin / MIN_REV;\n"
	"  float ah = am / 12.0;\n"
	"  float minute = seg(q, rot(vec2(0.0, -28.0), am)) - 2.5;\n"
	"  float hour = seg(q, rot(vec2(14.0, 10.0), ah)) - 2.5;\n"
	"  c = mix(c, TEXT, e * clamp(0.5 - ring / px, 0.0, 1.0));\n"
	"  c = mix(c, ACCENT, e * clamp(0.5 - minute / px, 0.0, 1.0));\n"
	"  c = mix(c, TEXT, e * clamp(0.5 - hour / px, 0.0, 1.0));\n"
	"  float e2 = ease((t - 0.15) / 0.7);\n"
	"  vec2 uv = (p - wmPos - vec2(0.0, 6.0 * (1.0 - e2))) / wmSize;\n"
	"  if (hasWm > 0.5 && uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0)\n"
	"    c = mix(c, TEXT, e2 * texture2D(wm, uv).r);\n"
	"  float n = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);\n"
	"  gl_FragColor = vec4(c + (n - 0.5) / 255.0, 1.0);\n"
	"}\n";

static GLuint shader(GLenum type, const char *src) {
	GLuint s = glCreateShader(type); GLint ok = 0; char msg[512] = "";
	glShaderSource(s, 1, &src, NULL); glCompileShader(s); glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
	if (!ok) { glGetShaderInfoLog(s, sizeof msg, NULL, msg); logmsg("shader: %s", msg); }
	return ok ? s : 0;
}

int main(int argc, char **argv) {
	signal(SIGCHLD, SIG_IGN);
	logfp = fopen(LOG_PATH, "a");
	double up = uptime();
	// launch params arrive as JSON in argv[1]; {"test":true} shows the splash for TEST_S without launching Minimal Home,
	// {"cold":true} runs the cold-boot path even though the TV has been up for a while
	int test = argc > 1 && strstr(argv[1], "\"test\":true") != NULL;
	if (argc > 1 && strstr(argv[1], "\"cold\":true")) up = 0;
	logmsg("start pid=%d%s", (int)getpid(), test ? " (test)" : "");
	if (!test) {
		if (up > WAKE_UPTIME_S) { launch_main("wake", 0); logmsg("not a cold boot - no splash"); finish_launches(); return 0; }
		launch_main("boot", 1);
	}

	if (!load_libs()) return 1;
	if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0) { logmsg("SDL_Init: %s", SDL_GetError()); return 1; }
	SDL_GL_SetAttribute(21, 4); SDL_GL_SetAttribute(17, 2); SDL_GL_SetAttribute(18, 0);   // GLES 2.0 context
	void *win = SDL_CreateWindow("Minimal Home", 0, 0, W, H, SDL_WINDOW_OPENGL | SDL_WINDOW_FULLSCREEN);
	if (!win || !SDL_GL_CreateContext(win)) { logmsg("window: %s", SDL_GetError()); return 1; }
	SDL_GL_SetSwapInterval(1);
	glViewport(0, 0, W, H);
	glClearColor(7 / 255.0f, 8 / 255.0f, 12 / 255.0f, 1.0f); glClear(GL_COLOR_BUFFER_BIT); SDL_GL_SwapWindow(win);
	logmsg("window up");

	GLuint vs = shader(GL_VERTEX_SHADER, VS), fs = shader(GL_FRAGMENT_SHADER, FS);
	if (!vs || !fs) return 1;
	GLuint prog = glCreateProgram(); GLint linked = 0;
	glAttachShader(prog, vs); glAttachShader(prog, fs); glBindAttribLocation(prog, 0, "pos"); glLinkProgram(prog);
	glGetProgramiv(prog, GL_LINK_STATUS, &linked);
	if (!linked) { logmsg("link failed"); return 1; }
	glUseProgram(prog);
	static const GLfloat quad[] = { -1, -1, 1, -1, -1, 1, 1, 1 };
	glVertexAttribPointer(0, 2, GL_FLOAT, 0, 0, quad); glEnableVertexAttribArray(0);
	GLint uT = glGetUniformLocation(prog, "t");

	int ww = 0, wh = 0;
	unsigned char *px = load_wordmark(&ww, &wh);
	GLuint tex; glGenTextures(1, &tex); glBindTexture(GL_TEXTURE_2D, tex);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
	glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
	if (px) { glPixelStorei(GL_UNPACK_ALIGNMENT, 1); glTexImage2D(GL_TEXTURE_2D, 0, GL_LUMINANCE, ww, wh, 0, GL_LUMINANCE, GL_UNSIGNED_BYTE, px); free(px); }
	glUniform1i(glGetUniformLocation(prog, "wm"), 0);
	glUniform2f(glGetUniformLocation(prog, "wmPos"), WM_X, WM_Y);
	glUniform2f(glGetUniformLocation(prog, "wmSize"), (float)ww, (float)wh);
	glUniform1f(glGetUniformLocation(prog, "hasWm"), px ? 1.0f : 0.0f);
	logmsg("wordmark %s", px ? "loaded" : "missing");

	double t0 = now_s(), lastLaunch = t0;
	int frames = 0;
	for (;;) {
		SDL_Event e;
		while (SDL_PollEvent(&e)) {
			int gone = e.type == SDL_QUIT || e.type == SDL_APP_WILLENTERBACKGROUND || e.type == SDL_APP_DIDENTERBACKGROUND ||
				(e.type == SDL_WINDOWEVENT && (e.window.event == SDL_WINDOWEVENT_HIDDEN || e.window.event == SDL_WINDOWEVENT_MINIMIZED));
			if (gone) { logmsg("covered/closed (event 0x%x/%d) after %d frames - done", e.type, e.type == SDL_WINDOWEVENT ? e.window.event : 0, frames); finish_launches(); return 0; }
		}
		double t = now_s() - t0;
		if (test && t > TEST_S) { logmsg("test done after %d frames", frames); launch_main("test done", 0); finish_launches(); return 0; }
		if (t > MAX_SHOW_S) { logmsg("still in front after %.0f s - launching once more and quitting", t); launch_main("timeout", 0); finish_launches(); return 0; }
		if (!test && now_s() - lastLaunch > RELAUNCH_EVERY_S) { lastLaunch = now_s(); launch_main("repeat", 0); }
		glUniform1f(uT, (float)t);
		glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
		SDL_GL_SwapWindow(win);
		if (++frames == 1) logmsg("first frame");
	}
}
