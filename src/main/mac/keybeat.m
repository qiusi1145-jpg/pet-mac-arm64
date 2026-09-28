// 打字探针（macOS 版）—— 与 src/main/typing.js 里 Windows 那份 C# 探针同一职责、同一红线。
//
// 只上报"有一个文本键被按下"：每命中一次往 stdout 写一行 `k`，**键值不出这个进程**、
// 不落盘、不进日志。白名单由 argv 注入（唯一事实来源是 src/shared/typing.js 的
// TEXT_CHARS_MAC / TEXT_KEYCODES_MAC），所以改判定不用重编这个文件。
//
// 为什么用 CGEventTap(listen-only) 而不是 addGlobalMonitorForEvents：
//   实测后者在本进程里**注册成功、返回非 nil、却一个事件都收不到**（它依赖 AppKit 的
//   事件派发链路，对无 nib 的命令行工具不成立，连 NSApplicationLoad() 都救不回来）。
//   CGEventTap 把端口显式挂进当前 runloop，不经 AppKit，是 CLI 工具的可靠路径。
//   而且 kCGEventTapOptionListenOnly **按定义只能旁听、不能拦截或改写**，
//   所以"绝不错过、绝不吞键"这条红线在这里是结构成立的（比 Windows 靠写对 CallNextHookEx 更硬）。
//
// 权限：未授予「辅助功能」时事件不会到达**且不报错**。所以首行自检报 t/n 给父进程，
//   主进程也查 systemPreferences.isTrustedAccessibilityClient()，未授权就置灰 + 引导，
//   绝不允许"选了形态三却毫无反应"。
//
// 与 Windows 侧共有的不可为边界：Secure Input 开启期间（密码框等）系统不外发按键事件，
//   等价于 Windows 上看不见以管理员权限运行的程序的按键（UIPI）。
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>
#include <string.h>

// 判定表放文件级静态区：回调拿不到用户上下文之外的东西，且这是单用途进程。
static unsigned char gAllow[256];
static long gCodes[16];
static int gNCodes = 0;

static void beat(void) { fputc('k', stdout); fflush(stdout); }

static CGEventRef tapCb(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon) {
  (void)proxy; (void)refcon;
  if (type != kCGEventKeyDown) return event;

  const CGEventFlags f = CGEventGetFlags(event);
  if (f & (kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand)) return event;

  const int64_t kc = CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
  for (int i = 0; i < gNCodes; i++) if (gCodes[i] == (long)kc) { beat(); return event; }

  // 取这个键在当前修饰状态下产生的字符。Shift+A→'A'，转小写后与 Windows 的 VK 语义对齐。
  // 只认单字节 ASCII：中文输入法组词期给的就是拼音字母（ASCII），所以中英同一套判定。
  UniChar u[4]; UniCharCount cnt = 0;
  CGEventKeyboardGetUnicodeString(event, 4, &cnt, u);
  if (cnt == 1 && u[0] < 128) {
    const char c = (char)tolower((int)u[0]);
    if (gAllow[(unsigned char)c]) beat();
  }
  return event;   // listen-only：返回值被系统忽略，事件原样继续派发给目标程序
}

int main(int argc, const char **argv) {
  // argv[1] = 可打印字符白名单；argv[2] = 特殊键的 macOS 虚拟键码，逗号分隔
  const unsigned char *chars = (const unsigned char *)(argc > 1 ? argv[1] : "");
  for (const unsigned char *p = chars; *p; p++) gAllow[*p] = 1;

  if (argc > 2) {
    char *buf = strdup(argv[2]);
    char *save = NULL;
    for (char *tok = strtok_r(buf, ",", &save); tok && gNCodes < 16; tok = strtok_r(NULL, ",", &save)) {
      gCodes[gNCodes++] = strtol(tok, NULL, 10);
    }
    free(buf);
  }

  // 自检行：把"是否被 TCC 信任"报给父进程（未授权时事件不来且不报错，没这行只能靠猜）
  fputc(AXIsProcessTrusted() ? 't' : 'n', stdout);
  fputc('\n', stdout);
  fflush(stdout);

  CFMachPortRef tap = CGEventTapCreate(
    kCGHIDEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
    CGEventMaskBit(kCGEventKeyDown), tapCb, NULL);
  if (!tap) return 4;   // 建不起来（通常是无辅助功能权限）

  CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  if (!src) { CFRelease(tap); return 5; }
  CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);

  CFRunLoopRun();       // 探针由父进程 kill，自己不退
  return 0;
}
