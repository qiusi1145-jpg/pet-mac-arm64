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
//   绝不允许"选了打字状态却毫无反应"。
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

// 协议是**行协议**：父进程用 readline 按 '\n' 切行（`src/main/typing.js` 里 `s === 'k'` 才发一拍）。
// 少了这个换行，56 下按键会攒成没终止的一行，readline 一行都不吐 → 探针活着、事件也收到了，
// 界面上却完全没有反应（实测踩过，且 tools/typing-live-test.sh 按字符数 k 所以当时报了绿灯）。
static void beat(void) { fputs("k\n", stdout); fflush(stdout); }

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
    return event;
  }
  // 兜底：远控/合成注入的键盘事件常**不带 Unicode 串**（cnt=0），真键盘总是带。
  // 2026-10-03 M2 云机实测：ToDesk 注入下 回车(键码36)/退格(51) 命中键码白名单能触发，
  // 字母全丢 —— 注入事件缺 Unicode 字段所致。此时按 ANSI 键码表折算成小写字母再过白名单。
  if (cnt == 0) {
    static const struct { int kc; char ch; } kANSI[] = {
      {0x00,'a'},{0x01,'s'},{0x02,'d'},{0x03,'f'},{0x04,'h'},{0x05,'g'},{0x06,'z'},
      {0x07,'x'},{0x08,'c'},{0x09,'v'},{0x0B,'b'},{0x0C,'q'},{0x0D,'w'},{0x0E,'e'},
      {0x0F,'r'},{0x10,'y'},{0x11,'t'},{0x12,'1'},{0x13,'2'},{0x14,'3'},{0x15,'4'},
      {0x16,'6'},{0x17,'5'},{0x19,'9'},{0x1A,'7'},{0x1B,'-'},{0x1C,'8'},{0x1D,'0'},
      {0x1F,'o'},{0x20,'u'},{0x21,'['},{0x22,'i'},{0x23,'p'},{0x25,'l'},{0x26,'j'},
      {0x27,'\''},{0x28,'k'},{0x29,';'},{0x2B,','},{0x2C,'/'},{0x2D,'n'},{0x2E,'m'},
      {0x2F,'.'},{0x18,'='},{0x1E,']'},{0x2A,'\\'},{0x32,'`'},
    };
    for (size_t i = 0; i < sizeof kANSI / sizeof kANSI[0]; i++) {
      if (kANSI[i].kc == (int)kc) {
        if (gAllow[(unsigned char)kANSI[i].ch]) beat();
        break;
      }
    }
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

  // 挂载点必须是**会话层**（kCGSessionEventTap），不能是 HID 层（kCGHIDEventTap）：
  //   物理键盘事件 HID→会话全程流经，两层都看得见；
  //   但远控/合成输入（ToDesk/向日葵/VNC/osascript 的 CGEventPost 系注入）**从会话层进入**，
  //   HID 层的 tap 结构上永远看不到 —— 2026-10-03 在 M2 云机实测：探针健康+已信任，
  //   ToDesk 真敲 22 秒 = 0 节拍，osascript 合成 10 键（注入成功）= 0 节拍，Secure Input 未开。
  //   Windows 侧 WH_KEYBOARD_LL 默认能看到 SendInput 注入的键，两层对齐后行为一致。
  CFMachPortRef tap = CGEventTapCreate(
    kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
    CGEventMaskBit(kCGEventKeyDown), tapCb, NULL);
  if (!tap) return 4;   // 建不起来（通常是无辅助功能权限）

  CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
  if (!src) { CFRelease(tap); return 5; }
  CFRunLoopAddSource(CFRunLoopGetCurrent(), src, kCFRunLoopCommonModes);
  CGEventTapEnable(tap, true);

  CFRunLoopRun();       // 探针由父进程 kill，自己不退
  return 0;
}
