// Public AppKit APIs only. NSGlassEffectView is resolved dynamically so this
// N-API binary still loads on macOS versions predating Liquid Glass.
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <cmath>
#include <cstring>
#include <vector>
#ifndef SHELFDOCK_GLASS_TEST
#include <node_api.h>
#endif

@protocol ShelfDockGlassAPI
@property (nullable, strong) NSView *contentView;
@property CGFloat cornerRadius;
@property NSInteger style;
@property (nullable, copy) NSColor *tintColor;
@end

@interface ShelfDockGlassState : NSObject
@property (strong) NSView *originalContent;
@property (strong) NSView<ShelfDockGlassAPI> *glass;
@property (strong) NSColor *originalBackground;
@property BOOL originalOpaque;
@property NSWindowStyleMask originalStyleMask;
@end
@implementation ShelfDockGlassState
@end
static char kGlassState;

static bool Supported() {
  if (@available(macOS 26.0, *)) return NSClassFromString(@"NSGlassEffectView") != Nil;
  return false;
}
static bool ReduceTransparency() {
  return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceTransparency;
}
static bool ReduceMotion() {
  return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
}
static bool RemoveGlass(NSWindow *window) {
  ShelfDockGlassState *state = objc_getAssociatedObject(window, &kGlassState);
  if (!state) return false;
  NSResponder *responder = window.firstResponder;
  NSRect frame = state.glass.frame;
  // Remove before restoring so the content never has two owners in the hierarchy.
  state.glass.contentView = nil;
  state.originalContent.frame = frame;
  window.contentView = state.originalContent;
  window.styleMask = (window.styleMask & ~NSWindowStyleMaskFullSizeContentView) | (state.originalStyleMask & NSWindowStyleMaskFullSizeContentView);
  window.backgroundColor = state.originalBackground;
  window.opaque = state.originalOpaque;
  if (responder) [window makeFirstResponder:responder];
  objc_setAssociatedObject(window, &kGlassState, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return true;
}
static const char *ApplyGlass(NSWindow *window, double radius, bool clear) {
  if (!NSThread.isMainThread) return "main-thread-required";
  if (!window || !window.contentView) return "window-unavailable";
  if (!Supported()) return "macos-26-required";
  if (ReduceTransparency()) {
    RemoveGlass(window);
    return "reduced-transparency";
  }
  ShelfDockGlassState *state = objc_getAssociatedObject(window, &kGlassState);
  if (!state) {
    NSView *content = window.contentView;
    NSView<ShelfDockGlassAPI> *glass = [(NSView<ShelfDockGlassAPI> *)[NSClassFromString(@"NSGlassEffectView") alloc] initWithFrame:content.frame];
    if (!glass) return "glass-allocation-failed";
    state = [ShelfDockGlassState new];
    state.originalContent = content;
    state.originalBackground = window.backgroundColor;
    state.originalOpaque = window.opaque;
    state.originalStyleMask = window.styleMask;
    state.glass = glass;
    NSResponder *responder = window.firstResponder;
    glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    content.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    // Electron's BridgedContentView normally extends a frameless window
    // underneath its titlebar. A plain AppKit root needs this public style bit
    // to preserve that full-height geometry after replacement and resizing.
    window.styleMask |= NSWindowStyleMaskFullSizeContentView;
    window.contentView = glass;
    // Apple requires contentView, not an arbitrary sibling behind web content.
    glass.contentView = content;
    objc_setAssociatedObject(window, &kGlassState, state, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if (responder) [window makeFirstResponder:responder];
  }
  state.glass.cornerRadius = std::fmax(0, std::fmin(32, radius));
  state.glass.style = clear ? 1 : 0;
  // ShelfDock intentionally uses a light lavender UI on every platform.
  state.glass.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
  state.glass.tintColor = [NSColor colorWithSRGBRed:0.80 green:0.79 blue:0.95 alpha:0.06];
  // A full shelf is not one interactive button; leave effectIsInteractive at
  // its default NO. AppKit independently honours accessibility motion settings.
  window.opaque = NO;
  window.backgroundColor = NSColor.clearColor;
  [state.glass setNeedsLayout:YES];
  [window.contentView layoutSubtreeIfNeeded];
  return "applied";
}

#ifndef SHELFDOCK_GLASS_TEST
static void SetBool(napi_env env, napi_value result, const char *key, bool value) {
  napi_value field; napi_get_boolean(env, value, &field); napi_set_named_property(env, result, key, field);
}
static napi_value Status(napi_env env, const char *reason) {
  napi_value result, field; napi_create_object(env, &result);
  SetBool(env, result, "supported", Supported());
  SetBool(env, result, "applied", std::strcmp(reason, "applied") == 0);
  SetBool(env, result, "reducedTransparency", ReduceTransparency());
  SetBool(env, result, "reducedMotion", ReduceMotion());
  napi_create_string_utf8(env, reason, NAPI_AUTO_LENGTH, &field); napi_set_named_property(env, result, "reason", field);
  return result;
}
static NSWindow *WindowFromHandle(napi_env env, napi_value value) {
  bool buffer = false; napi_is_buffer(env, value, &buffer);
  if (!buffer) return nil;
  void *bytes = nullptr; size_t length = 0;
  if (napi_get_buffer_info(env, value, &bytes, &length) != napi_ok || length != sizeof(void *)) return nil;
  void *pointer = nullptr; std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer) return nil;
  // This pointer is accepted only by the private main-process BrowserWindow
  // adapter. Never expose this API or accept a renderer-supplied pointer.
  NSView *view = (__bridge NSView *)pointer;
  return view.window;
}
static napi_value GetStatus(napi_env env, napi_callback_info info) {
  @autoreleasepool { return Status(env, Supported() ? "available" : "macos-26-required"); }
}
static napi_value Apply(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    if (!NSThread.isMainThread) return Status(env, "main-thread-required");
    size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc < 1) return Status(env, "invalid-handle");
    double radius = 18; bool clear = false;
    if (argc > 1) { double candidate; if (napi_get_value_double(env, args[1], &candidate) == napi_ok && std::isfinite(candidate)) radius = candidate; }
    if (argc > 2) napi_get_value_bool(env, args[2], &clear);
    NSWindow *window = WindowFromHandle(env, args[0]);
    if (!window) return Status(env, "invalid-handle");
    return Status(env, ApplyGlass(window, radius, clear));
  }
}
static napi_value Remove(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    if (!NSThread.isMainThread) return Status(env, "main-thread-required");
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    NSWindow *window = argc ? WindowFromHandle(env, args[0]) : nil;
    return Status(env, window && RemoveGlass(window) ? "removed" : "not-applied");
  }
}
static napi_value Inspect(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    NSWindow *window = argc ? WindowFromHandle(env, args[0]) : nil;
    napi_value result; napi_create_object(env, &result);
    if (!window) return result;
    ShelfDockGlassState *state = objc_getAssociatedObject(window, &kGlassState);
    SetBool(env, result, "nativeGlass", state && [window.contentView isKindOfClass:NSClassFromString(@"NSGlassEffectView")]);
    SetBool(env, result, "visible", window.isVisible);
    SetBool(env, result, "contentAttached", state && state.originalContent.window == window && state.glass.contentView == state.originalContent);
    napi_value field;
    napi_create_string_utf8(env, NSStringFromClass(window.contentView.class).UTF8String, NAPI_AUTO_LENGTH, &field);
    napi_set_named_property(env, result, "containerClass", field);
    NSSize glassSize = window.contentView.bounds.size;
    NSSize contentSize = state ? state.originalContent.bounds.size : glassSize;
    const char *names[] = {"glassWidth", "glassHeight", "contentWidth", "contentHeight"};
    double values[] = {glassSize.width, glassSize.height, contentSize.width, contentSize.height};
    napi_create_double(env, window.frame.size.height, &field); napi_set_named_property(env,result,"windowHeight",field);
    napi_create_double(env, window.styleMask, &field); napi_set_named_property(env,result,"styleMask",field);
    for (int i = 0; i < 4; ++i) { napi_create_double(env, values[i], &field); napi_set_named_property(env, result, names[i], field); }
    return result;
  }
}
struct AccessibilityWatcher {
  napi_env env;
  napi_ref callback;
  napi_async_context context;
  id observer;
  uint32_t token;
};
static std::vector<AccessibilityWatcher *> watchers;
static uint32_t nextWatcher = 1;
static void DeleteWatcher(AccessibilityWatcher *watcher) {
  [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:watcher->observer];
  napi_delete_reference(watcher->env, watcher->callback);
  napi_async_destroy(watcher->env, watcher->context);
  delete watcher;
}
static void CleanupWatchers(void *data) {
  napi_env env = static_cast<napi_env>(data);
  for (auto it = watchers.begin(); it != watchers.end();) {
    if ((*it)->env == env) { DeleteWatcher(*it); it = watchers.erase(it); } else ++it;
  }
}
static napi_value WatchAccessibility(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  napi_valuetype type; if (!argc || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Accessibility listener must be a function"); return nullptr;
  }
  AccessibilityWatcher *watcher = new AccessibilityWatcher{env, nullptr, nullptr, nil, nextWatcher++};
  napi_create_reference(env, args[0], 1, &watcher->callback);
  napi_value resource, name; napi_create_object(env, &resource);
  napi_create_string_utf8(env, "shelfdock:accessibility", NAPI_AUTO_LENGTH, &name);
  napi_async_init(env, resource, name, &watcher->context);
  watcher->observer = [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
    napi_handle_scope scope; if (napi_open_handle_scope(env, &scope) != napi_ok) return;
    napi_value callback, receiver, ignored, status = Status(env, "accessibility-changed");
    napi_get_reference_value(env, watcher->callback, &callback); napi_get_undefined(env, &receiver);
    napi_make_callback(env, watcher->context, receiver, callback, 1, &status, &ignored);
    napi_close_handle_scope(env, scope);
  }];
  watchers.push_back(watcher);
  napi_value token; napi_create_uint32(env, watcher->token, &token); return token;
}
static napi_value UnwatchAccessibility(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  uint32_t token = 0; if (argc) napi_get_value_uint32(env, args[0], &token);
  for (auto it = watchers.begin(); it != watchers.end(); ++it) {
    if ((*it)->env == env && (*it)->token == token) { DeleteWatcher(*it); watchers.erase(it); break; }
  }
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"getStatus", nullptr, GetStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspect", nullptr, Inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"watchAccessibility", nullptr, WatchAccessibility, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unwatchAccessibility", nullptr, UnwatchAccessibility, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  napi_add_env_cleanup_hook(env, CleanupWatchers, env);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#else
#include <cassert>
#include <cstdio>
@interface ShelfDockFocusView : NSView
@end
@implementation ShelfDockFocusView
- (BOOL)acceptsFirstResponder { return YES; }
@end
int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 640, 540) styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskResizable backing:NSBackingStoreBuffered defer:YES];
    window.releasedWhenClosed = NO;
    NSView *original = window.contentView;
    NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(30, 30, 150, 30)];
    [original addSubview:field];
    ShelfDockFocusView *focus = [[ShelfDockFocusView alloc] initWithFrame:NSMakeRect(200, 30, 150, 30)];
    [original addSubview:focus];
    [window makeFirstResponder:focus];
    NSResponder *responder = window.firstResponder;
    bool opaque = window.opaque;
    NSColor *background = window.backgroundColor;
    const char *reason = ApplyGlass(window, 18, false);
    if (!Supported() || ReduceTransparency()) {
      assert(std::strcmp(reason, Supported() ? "reduced-transparency" : "macos-26-required") == 0);
      assert(window.contentView == original);
      std::puts("Native glass unavailable/disabled: correct fallback, no visible window.");
    } else {
      assert(std::strcmp(reason, "applied") == 0);
      ShelfDockGlassState *state = objc_getAssociatedObject(window, &kGlassState);
      assert([window.contentView isKindOfClass:NSClassFromString(@"NSGlassEffectView")]);
      assert(state.glass.contentView == original);
      assert(window.firstResponder == responder);
      assert(!window.isVisible);
      NSView *hit = [window.contentView hitTest:NSMakePoint(45, 45)];
      assert(hit == field || [hit isDescendantOf:field]);
      [window setContentSize:NSMakeSize(900, 700)];
      [window.contentView layoutSubtreeIfNeeded];
      assert(std::fabs(original.bounds.size.width - 900) < 1);
      assert(std::fabs(original.bounds.size.height - 700) < 1);
      assert(std::strcmp(ApplyGlass(window, 24, true), "applied") == 0);
      assert(objc_getAssociatedObject(window, &kGlassState) == state);
      assert(state.glass.cornerRadius == 24 && state.glass.style == 1);
      assert(RemoveGlass(window));
      assert(window.contentView == original);
      assert(window.firstResponder == responder);
      assert(window.opaque == opaque && [window.backgroundColor isEqual:background]);
      assert(!RemoveGlass(window));
      assert(std::strcmp(ApplyGlass(window, 18, false), "applied") == 0);
      assert(!window.isVisible);
      std::puts("Native NSGlassEffectView: content ownership, hit target, responder, resize, idempotence, removal/reapply passed; no visible window.");
    }
    [window close];
  }
  return 0;
}
#endif
