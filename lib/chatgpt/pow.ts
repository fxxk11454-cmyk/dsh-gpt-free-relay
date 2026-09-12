/**
 * vendored —— 原样取自 pi-gpt v0.4.3（MIT），它又移植自 lanqian528/chat2api（MIT）。
 *
 * 这一段是 ChatGPT 的 Sentinel 反机器人门禁：
 *   - pow.ts       工作量证明（SHA3-512），纯 Node 实现
 *   - turnstile.ts 把服务端下发的字节码回放一遍，纯 Node 实现（不是真 Turnstile 求解）
 *   - sentinel.ts  两者串起来，产出 chat-requirements / proof / turnstile 三个 token
 *
 * 之所以原样 vendor 不重写：这里的指纹数组（navigatorKey / windowKey）是会被
 * 哈希进去的，改动任何一个字符都会导致 proof 校验失败。而且上游随时会变，
 * 保持与上游实现一字不差，将来 diff 升级最省事。
 *
 * 本文件保留了 Node 原生类型标注 —— Node 24 支持类型剥离，可直接 import。
 */
// Proof-of-work solver for chatgpt.com sentinel gate.
// Ported from lanqian528/chat2api (MIT) — same algorithm as gpt2agent's vendored pow.py.
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const _cores = [8, 16, 24, 32];
const _timeLayout = "%a %b %d %Y %H:%M:%S";

const navigatorKey: string[] = [
  "registerProtocolHandler−function registerProtocolHandler() { [native code] }",
  "storage−[object StorageManager]",
  "locks−[object LockManager]",
  "appCodeName−Mozilla",
  "permissions−[object Permissions]",
  "share−function share() { [native code] }",
  "webdriver−false",
  "managed−[object NavigatorManagedData]",
  "canShare−function canShare() { [native code] }",
  "vendor−Google Inc.",
  "vendor−Google Inc.",
  "mediaDevices−[object MediaDevices]",
  "vibrate−function vibrate() { [native code] }",
  "storageBuckets−[object StorageBucketManager]",
  "mediaCapabilities−[object MediaCapabilities]",
  "getGamepads−function getGamepads() { [native code] }",
  "bluetooth−[object Bluetooth]",
  "share−function share() { [native code] }",
  "cookieEnabled−true",
  "virtualKeyboard−[object VirtualKeyboard]",
  "product−Gecko",
  "mediaDevices−[object MediaDevices]",
  "canShare−function canShare() { [native code] }",
  "getGamepads−function getGamepads() { [native code] }",
  "product−Gecko",
  "xr−[object XRSystem]",
  "clipboard−[object Clipboard]",
  "storageBuckets−[object StorageBucketManager]",
  "unregisterProtocolHandler−function unregisterProtocolHandler() { [native code] }",
  "productSub−20030107",
  "login−[object NavigatorLogin]",
  "vendorSub−",
  "login−[object NavigatorLogin]",
  "getInstalledRelatedApps−function getInstalledRelatedApps() { [native code] }",
  "mediaDevices−[object MediaDevices]",
  "locks−[object LockManager]",
  "webkitGetUserMedia−function webkitGetUserMedia() { [native code] }",
  "vendor−Google Inc.",
  "xr−[object XRSystem]",
  "mediaDevices−[object MediaDevices]",
  "virtualKeyboard−[object VirtualKeyboard]",
  "virtualKeyboard−[object VirtualKeyboard]",
  "appName−Netscape",
  "storageBuckets−[object StorageBucketManager]",
  "presentation−[object Presentation]",
  "onLine−true",
  "mimeTypes−[object MimeTypeArray]",
  "credentials−[object CredentialsContainer]",
  "presentation−[object Presentation]",
  "getGamepads−function getGamepads() { [native code] }",
  "vendorSub−",
  "virtualKeyboard−[object VirtualKeyboard]",
  "serviceWorker−[object ServiceWorkerContainer]",
  "xr−[object XRSystem]",
  "product−Gecko",
  "keyboard−[object Keyboard]",
  "gpu−[object GPU]",
  "getInstalledRelatedApps−function getInstalledRelatedApps() { [native code] }",
  "webkitPersistentStorage−[object DeprecatedStorageQuota]",
  "doNotTrack",
  "clearAppBadge−function clearAppBadge() { [native code] }",
  "presentation−[object Presentation]",
  "serial−[object Serial]",
  "locks−[object LockManager]",
  "requestMIDIAccess−function requestMIDIAccess() { [native code] }",
  "locks−[object LockManager]",
  "requestMediaKeySystemAccess−function requestMediaKeySystemAccess() { [native code] }",
  "vendor−Google Inc.",
  "pdfViewerEnabled−true",
  "language−en-US",
  "setAppBadge−function setAppBadge() { [native code] }",
  "geolocation−[object Geolocation]",
  "userAgentData−[object NavigatorUAData]",
  "mediaCapabilities−[object MediaCapabilities]",
  "requestMIDIAccess−function requestMIDIAccess() { [native code] }",
  "getUserMedia−function getUserMedia() { [native code] }",
  "mediaDevices−[object MediaDevices]",
  "webkitPersistentStorage−[object DeprecatedStorageQuota]",
  "sendBeacon−function sendBeacon() { [native code] }",
  "hardwareConcurrency−32",
  "credentials−[object CredentialsContainer]",
  "storage−[object StorageManager]",
  "cookieEnabled−true",
  "pdfViewerEnabled−true",
  "windowControlsOverlay−[object WindowControlsOverlay]",
  "scheduling−[object Scheduling]",
  "pdfViewerEnabled−true",
  "hardwareConcurrency−32",
  "xr−[object XRSystem]",
  "webdriver−false",
  "getInstalledRelatedApps−function getInstalledRelatedApps() { [native code] }",
  "getInstalledRelatedApps−function getInstalledRelatedApps() { [native code] }",
  "bluetooth−[object Bluetooth]",
];

const documentKey = ["_reactListeningo743lnnpvdg", "location"];

const windowKey: string[] = [
  "0","window","self","document","name","location","customElements","history","navigation","locationbar","menubar","personalbar","scrollbars","statusbar","toolbar","status","closed","frames","length","top","opener","parent","frameElement","navigator","origin","external","screen","innerWidth","innerHeight","scrollX","pageXOffset","scrollY","pageYOffset","visualViewport","screenX","screenY","outerWidth","outerHeight","devicePixelRatio","clientInformation","screenLeft","screenTop","styleMedia","onsearch","isSecureContext","trustedTypes","performance","onappinstalled","onbeforeinstallprompt","crypto","indexedDB","sessionStorage","localStorage","onbeforexrselect","onabort","onbeforeinput","onbeforematch","onbeforetoggle","onblur","oncancel","oncanplay","oncanplaythrough","onchange","onclick","onclose","oncontentvisibilityautostatechange","oncontextlost","oncontextmenu","oncontextrestored","oncuechange","ondblclick","ondrag","ondragend","ondragenter","ondragleave","ondragover","ondragstart","ondrop","ondurationchange","onemptied","onended","onerror","onfocus","onformdata","oninput","oninvalid","onkeydown","onkeypress","onkeyup","onload","onloadeddata","onloadedmetadata","onloadstart","onmousedown","onmouseenter","onmouseleave","onmousemove","onmouseout","onmouseover","onmouseup","onmousewheel","onpause","onplay","onplaying","onprogress","onratechange","onreset","onresize","onscroll","onsecuritypolicyviolation","onseeked","onseeking","onselect","onslotchange","onstalled","onsubmit","onsuspend","ontimeupdate","ontoggle","onvolumechange","onwaiting","onwebkitanimationend","onwebkitanimationiteration","onwebkitanimationstart","onwebkittransitionend","onwheel","onauxclick","ongotpointercapture","onlostpointercapture","onpointerdown","onpointermove","onpointerrawupdate","onpointerup","onpointercancel","onpointerover","onpointerout","onpointerenter","onpointerleave","onselectstart","onselectionchange","onanimationend","onanimationiteration","onanimationstart","ontransitionrun","ontransitionstart","ontransitionend","ontransitioncancel","onafterprint","onbeforeprint","onbeforeunload","onhashchange","onlanguagechange","onmessage","onmessageerror","onoffline","ononline","onpagehide","onpageshow","onpopstate","onrejectionhandled","onstorage","onunhandledrejection","onunload","crossOriginIsolated","scheduler","alert","atob","blur","btoa","cancelAnimationFrame","cancelIdleCallback","captureEvents","clearInterval","clearTimeout","close","confirm","createImageBitmap","fetch","find","focus","getComputedStyle","getSelection","matchMedia","moveBy","moveTo","open","postMessage","print","prompt","queueMicrotask","releaseEvents","reportError","requestAnimationFrame","requestIdleCallback","resizeBy","resizeTo","scroll","scrollBy","scrollTo","setInterval","setTimeout","stop","structuredClone","webkitCancelAnimationFrame","webkitRequestAnimationFrame","chrome","caches","cookieStore","ondevicemotion","ondeviceorientation","ondeviceorientationabsolute","launchQueue","documentPictureInPicture","getScreenDetails","queryLocalFonts","showDirectoryPicker","showOpenFilePicker","showSaveFilePicker","originAgentCluster","onpageswap","onpagereveal","credentialless","speechSynthesis","onscrollend","webkitRequestFileSystem","webkitResolveLocalFileSystemURL","sendMsgToSolverCS","webpackChunk_N_E","__next_set_public_path__","next","__NEXT_DATA__","__SSG_MANIFEST_CB","__NEXT_P","_N_E","regeneratorRuntime","__REACT_INTL_CONTEXT__","DD_RUM","_","filterCSS","filterXSS","__SEGMENT_INSPECTOR__","__NEXT_PRELOADREADY","Intercom","__MIDDLEWARE_MATCHERS","__STATSIG_SDK__","__STATSIG_JS_SDK__","__STATSIG_RERENDER_OVERRIDE__","_oaiHandleSessionExpired","__BUILD_MANIFEST","__SSG_MANIFEST","__intercomAssignLocation","__intercomReloadLocation",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseTime(): string {
  const now = new Date(Date.now() - 5 * 3600 * 1000); // -0500
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${days[now.getUTCDay()]} ${months[now.getUTCMonth()]} ${pad(now.getUTCDate())} ` +
    `${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(
      now.getUTCSeconds(),
    )} GMT-0500 (Eastern Standard Time)`
  );
}

function buildConfig(userAgent: string): any[] {
  return [
    pick([1920 + 1080, 2560 + 1440, 1920 + 1200, 2560 + 1600]),
    parseTime(),
    4294705152,
    0,
    userAgent,
    "", // script_src
    "", // dpl
    "en-US",
    "en-US,es-US,en,es",
    0,
    pick(navigatorKey),
    pick(documentKey),
    pick(windowKey),
    performance.now(),
    randomUUID(),
    "",
    pick(_cores),
    Date.now() - performance.now(),
  ];
}

function compact(arr: any[], start = 0, end = arr.length): string {
  // Compact JSON like Python's separators=(",", ":").
  const slice = arr.slice(start, end);
  return JSON.stringify(slice).slice(1, -1);
}

function generateAnswer(seed: string, diff: string, config: any[]): [string, boolean] {
  // Python: diff_len = len(diff) (hex chars), target = bytes.fromhex(diff).
  // h[:diff_len] (more bytes) <= target (fewer bytes) — lexicographic, length-aware.
  // Buffer.compare mirrors Python's bytes comparison exactly.
  const sliceLen = diff.length;
  const seedEncoded = Buffer.from(seed, "utf8");
  const part1 = Buffer.from(`[${compact(config, 0, 3)},`, "utf8"); // [a,b,c,
  const part2 = Buffer.from(`,${compact(config, 4, 9)},`, "utf8"); // ,e,f,g,h,i,j,
  const part3 = Buffer.from(`,${compact(config, 10)}]`, "utf8"); // ,...]
  const target = Buffer.from(diff, "hex");

  for (let i = 0; i < 500000; i++) {
    const dynI = Buffer.from(String(i), "utf8");
    const dynJ = Buffer.from(String(i >> 1), "utf8");
    const finalBytes = Buffer.concat([part1, dynI, part2, dynJ, part3]);
    const baseEncoded = finalBytes.toString("base64");
    const h = createHash("sha3-512")
      .update(Buffer.concat([seedEncoded, Buffer.from(baseEncoded, "utf8")]))
      .digest();
    if (Buffer.compare(h.subarray(0, sliceLen), target) <= 0) return [baseEncoded, true];
  }
  return ["wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + Buffer.from(`"${seed}"`, "utf8").toString("base64"), false];
}

export function solvePow(seed: string, difficulty: string, userAgent: string): string {
  const config = buildConfig(userAgent);
  const [answer] = generateAnswer(seed, difficulty, config);
  return "gAAAAAB" + answer;
}

export function getRequirementsToken(userAgent: string): string {
  const config = buildConfig(userAgent);
  const [require] = generateAnswer(String(Math.random()), "0fffff", config);
  return "gAAAAAC" + require;
}
