# App quirks — field notes from live automation

UI Automation exposure varies wildly per app and per surface. Probe before choosing a control path:
a11y elements > keyboard shortcuts > screenshot-coordinate clicks. Every write is only dispatched —
write, then read back to confirm.

## WeChat 4.x (Weixin.exe — Qt shell + embedded Chromium)

| Surface | UIA exposure | Control path |
| --- | --- | --- |
| Login window (`mmui::LoginWindow`) | full tree | click by element_index |
| Main window (`mmui::MainWindow`) | near-empty (custom-drawn) | keyboard + screenshot coords |
| Search popover (`mmui::SearchContentPopover`) | full tree | element_index |
| 搜一搜 panel (embedded Chromium, `Chrome_WidgetWin_0`) | full Chrome tree | element_index |
| Chat view once open | `mmui::ChatInputField` + message items | element_index |

- The tray-hidden main window does not appear in `kimi_cu_windows`. Find the hwnd with an external
  window enumerator, restore visibility (`ShowWindow SW_RESTORE`), then observe by hwnd.
- A stray login/QR window does NOT mean the session is lost — do not scan or re-login; look for the
  real main window first (relaunching the exe can spawn a redundant login window).
- Search results mix sections (web results / 功能 official entries / chat history). Read the item
  full name and click the official entry, not the first hit; the wrong section opens the 搜一搜 web
  panel instead of the chat.
- The chat input gets focus when a chat opens: type, verify the value, then Enter to send.
- Same-named buttons cluster (multiple 关闭): the one at the title-bar corner closes the whole
  window — vet rect + class before clicking; close panels with their own X.

## Bing (search engines generally)

- `fill submit=true` reports success even when the suggestions dropdown swallowed the Enter and the
  page never navigated. Read back; if still on the search home, click the submit button element.
- CJK queries URL-encode correctly through the bridge; DOM `evaluate` reaches what the a11y tree
  only summarizes (e.g. count `#b_results > li.b_algo`).

## General rules (each earned the hard way)

1. Write → short sleep → read back. Never trust a dispatch-only success.
2. Element clicks beat coordinate clicks; coordinate clicks need a fresh snapshot (stale ids are
   rejected — re-observe first).
3. Keyboard shortcuts often reach surfaces the tree does not expose (Ctrl+F search, Enter to send).
4. Clean up what you opened (panels, tabs, temp files) and verify the final state.