# Fast Browser

Fast Browser cho Claude Code điều khiển Chrome thật của bạn (giữ nguyên phiên đăng nhập) nhanh hơn Claude in Chrome / Playwright MCP, nhờ bốn ý chính:

- **Gộp nhiều hành động vào một lượt:** một lần gọi `browser_act` chạy tới 50 bước ngay trong Chrome, kể cả khi trang chuyển giữa chừng. Model chỉ được gọi lại khi chuỗi xong hoặc có bước hỏng.
- **Snapshot gọn:** chỉ liệt kê phần tử tương tác trong viewport, kèm `[ref]`. Sau mỗi lượt chỉ gửi **diff** (`+` mới, `~` đổi, `-` mất).
- **Chờ DOM ổn định** (không có thay đổi trong 300ms, tối đa 2,5s) thay vì sleep cố định.
- **Workflow:** làm một lần, lưu lại, sau đó `browser_workflow run` chạy lại mà không cần model mò từng bước.

Kiến trúc: `server/` là MCP server (stdio) và mở một WebSocket bridge trên `127.0.0.1`. `extension/` là extension Chrome MV3 (JS thuần, không build), kết nối vào bridge. Hợp đồng giữa các thành phần nằm ở [SPEC.md](SPEC.md).

```
Claude Code ⇄ (stdio MCP) ⇄ server/src/index.js ⇄ (ws://127.0.0.1:17890) ⇄ extension (service worker) ⇄ page.js trong tab
```

## Cài đặt

Yêu cầu: Node 20+, Chrome 116+.

1. Cài dependency ở thư mục gốc repo:
   ```bash
   cd C:/WorkSpace/fast-browser
   npm install
   ```
2. Nạp extension: mở `chrome://extensions`, bật **Developer mode**, bấm **Load unpacked**, chọn thư mục `C:\WorkSpace\fast-browser\extension`.
3. Đăng ký MCP server với Claude Code:
   ```bash
   claude mcp add fast-browser -- node C:/WorkSpace/fast-browser/server/src/index.js
   ```
4. Mở Claude Code một lần để server tạo `~/.fast-browser/token` (chuỗi hex ngẫu nhiên).
5. Ghép cặp (một lần): mở popup của extension, dán nội dung file `~/.fast-browser/token` vào ô **Token**, bấm **Pair**. Extension chỉ nhận lệnh từ server chứng minh được là biết token này (HMAC qua nonce, hai chiều), nên một tiến trình khác chiếm cổng 17890 không điều khiển được trình duyệt.
6. Extension tự kết nối trong vài giây (thời gian chờ thử lại tăng dần từ 0,5s đến tối đa 5s). Icon extension không có badge nghĩa là đã kết nối; `…` là đang kết nối / xác thực; `!` là mất kết nối hoặc chưa ghép cặp (`unpaired`). Popup hiển thị trạng thái, cổng, token đã lưu hay chưa, danh sách domain được phép, và có nút kết nối lại.

## Cấu hình

File `~/.fast-browser/config.json` được tạo với giá trị mặc định ở lần chạy đầu:

```json
{ "port": 17890,
  "allowedDomains": ["creativeforce.io", "creativeforce-dev.io", "atlassian.net", "atlassian.com", "localhost", "127.0.0.1"] }
```

- `allowedDomains`: host khớp khi bằng đúng entry hoặc kết thúc bằng `.entry`. `"*"` cho phép mọi host, **trừ** địa chỉ loopback (`localhost`, `*.localhost`, cả dải `127.0.0.0/8`, `0.0.0.0`, `[::1]`, `[::]`, IPv4-mapped `[::ffff:127.…]`): các host này phải liệt kê rõ từng cái.
- Biến môi trường ghi đè: `FB_PORT`, `FB_ALLOWED_DOMAINS` (danh sách cách nhau bởi dấu phẩy), `FB_EXTENSION_ID`, `FB_HOME` (mặc định `~/.fast-browser`).
- `FB_EXTENSION_ID` / `extensionId` trong config: mặc định là `biombhedndgmjlfaklonbecohcobfndd`, ID cố định của extension (do `key` trong `extension/manifest.json`, không phụ thuộc thư mục nạp). Đặt `"*"` để nhận mọi extension (không khuyến nghị).
- Trần allowlist phía extension (tuỳ chọn): ô **Ceiling** trong popup. Khi đặt, một host phải nằm trong cả `allowedDomains` của server lẫn danh sách này, nên server chỉ thu hẹp được, không mở rộng được.
- Nếu đổi cổng, nhập cùng cổng đó trong popup của extension (lưu ở `chrome.storage.local`). Extension sẽ kết nối lại ngay.

Dữ liệu trong `FB_HOME`: `config.json`, `token` (bí mật ghép cặp với extension; xoá file để tạo token mới, rồi dán lại vào popup), `workflows/<name>.json`, `recording.json` (bộ đệm ghi hiện tại), `logs/calls-YYYY-MM-DD.jsonl`.

## 7 tool MCP

| Tool | Input | Dùng để |
| --- | --- | --- |
| `browser_tabs` | `{action: list\|goto\|new\|select\|close, url?, tabId?}` | Quản lý tab. `goto`/`new`/`select` trả kèm snapshot. `list` chỉ hiện host (`(not allowed: host)`, không tiêu đề) cho tab ngoài allowlist; `select` tab đó bị từ chối và không đổi tab hiện tại. |
| `browser_snapshot` | `{mode?: diff\|viewport\|full, region?, tabId?}` | Liệt kê phần tử tương tác với `[ref]`. Mặc định `viewport`. |
| `browser_act` | `{actions: Action[1..50], tabId?}` | Chạy cả chuỗi hành động; dừng ở bước hỏng đầu tiên; trả kết quả từng bước + diff snapshot. |
| `browser_extract` | `{kind?: text\|table\|links, region?, maxChars?, tabId?}` | Đọc nội dung dạng text, bảng markdown, hoặc danh sách link. |
| `browser_eval` | `{code, tabId?}` | Chạy JS (thân hàm async, dùng `return`) trong trang, chủ yếu để `fetch` API của chính app. |
| `browser_screenshot` | `{maxWidth?, quality?, tabId?}` | Ảnh JPEG đã thu nhỏ. Chỉ dùng cho canvas/biểu đồ. |
| `browser_workflow` | `{action: list\|run\|save\|show\|reset\|delete, name?, description?, params?}` | Ghi và chạy lại workflow. |

Một `Action` có dạng `{do, <target>, <payload>}`:

- `do`: `click`, `fill`, `select`, `check`, `press`, `hover`, `scroll`, `wait`, `navigate`.
- Target (chọn một): `ref` (lấy từ snapshot), `text` (+ `role` nếu cần), `selector` (CSS), hoặc `locator` (do workflow sinh ra).
- Payload: `value`, `checked`, `key` (`"Enter"`, `"Escape"`, `"Control+a"`…), `url`, `direction`/`amount`, `ms`/`waitText`/`waitSelector`, `noWait`.

Ví dụ một lượt điền form và submit:

```json
{ "actions": [
  { "do": "fill", "text": "Email", "value": "a@b.com" },
  { "do": "select", "text": "Trạng thái", "value": "Open" },
  { "do": "click", "text": "Lưu", "role": "button" },
  { "do": "wait", "waitText": "Đã lưu" } ] }
```

Kết quả trả về là text thuần:

```
✓ 1 fill textbox "Email"
✓ 2 select combobox "Trạng thái"
✓ 3 click button "Lưu"
✓ 4 wait
--- snapshot ---
(new page)
…
```

Nếu một bước hỏng, kết quả có dòng `✗ n …` với lỗi tự giải thích (ví dụ `no element matches text "Lưu" role=button; closest: [5] button "Lưu lại"`), kèm snapshot viewport đầy đủ để sửa và chạy tiếp trong một lần gọi.

## Workflow

1. `browser_workflow action=reset` để xoá bộ đệm ghi.
2. Làm tác vụ bằng tay với `browser_tabs goto` và `browser_act`. Mọi bước thành công đều được ghi lại, với `ref`/`text`/`selector` được thay bằng `locator` bền vững.
3. `browser_workflow action=save name=tao-don description="Tạo đơn" params={"customer":"Carol"}`: chuỗi `Carol` được thay bằng `{{customer}}` trong các trường mang dữ liệu người dùng: `value`, `waitText`, `text`, `locator.name`, và phần path/query/hash của `url` (không đụng scheme/host/port). `locator.selector`, `role`, `nth`, `key`, `waitSelector` không bao giờ bị thay, nên giá trị ngắn như `"5"` không làm hỏng `tr:nth-of-type(5)` hay cổng `:5173`. Ô mật khẩu luôn được lưu là `{{password}}` (tham số `password` được tự thêm).
4. Lần sau: `browser_workflow action=list` để xem danh sách, rồi `browser_workflow action=run name=tao-don params={"customer":"Dave","password":"…"}`. Toàn bộ các bước được gửi trong một `page.act`. Thiếu tham số sẽ báo lỗi kèm danh sách tham số cần có.
5. Nếu replay hỏng ở bước i: kết quả báo `failed at step i — finish with browser_act, then browser_workflow save name=<name>`. Bộ đệm ghi lúc này giữ các bước đã chạy được, nên chỉ cần làm nốt phần còn lại bằng `browser_act`, rồi `save` lại với cùng `params`.

`show name=<name>` in các bước dễ đọc. `show` không có name in bộ đệm ghi hiện tại. `delete name=<name>` xoá file workflow.

## Đọc số liệu (metrics)

Mỗi lần gọi tool ghi thêm một dòng JSONL vào `~/.fast-browser/logs/calls-YYYY-MM-DD.jsonl`:
`{ts, tool, action?, ms, ok, steps?, failedStep?, inChars, outChars}`.

Xem thống kê theo ngày:

```bash
node C:/WorkSpace/fast-browser/server/src/stats.js              # mọi ngày
node C:/WorkSpace/fast-browser/server/src/stats.js 2026-11-02   # một hoặc vài ngày
```

Mỗi ngày in một dòng tổng (số lượt gọi, thời gian trung bình, tỉ lệ lỗi, tổng ký tự output trả về model), rồi một dòng cho mỗi tool (số lượt, ms trung bình, tỉ lệ lỗi, tổng số bước với `browser_act`). Đây là nguồn dữ liệu cho benchmark: so sánh số lượt gọi và thời gian của cùng một tác vụ giữa Fast Browser và Claude in Chrome / Playwright MCP.

## Bảo mật

- Bridge chỉ nghe trên `127.0.0.1` và mặc định chỉ nhận `Origin: chrome-extension://biombhedndgmjlfaklonbecohcobfndd` (ID cố định của extension này), nên trang web và extension khác không kết nối được.
- Xác thực hai chiều bằng token `~/.fast-browser/token`: server chứng minh với extension (HMAC của nonce trong `hello`) trước khi extension nhận `allowedDomains` hay lệnh nào; extension chứng minh lại với server trước khi được nhận request. Kết nối chưa xác thực không nhận request và không đẩy được kết nối thật ra (quy tắc "mới nhất thắng" chỉ áp dụng cho kết nối đã xác thực); kết nối sai token bị đóng (mã 4003), im lặng quá 10s bị đóng (4001).
- Allowlist domain luôn bật: extension từ chối đọc hoặc thao tác trên tab, và từ chối điều hướng tới host không có trong `allowedDomains`, với lỗi `domain not allowed: <host> (…)`. Kiểm tra chạy trước **mọi** bước của `browser_act` (cả sau bước `noWait` hay redirect muộn), xét cả `pendingUrl` khi tab đang chuyển trang, và chạy lại ngay trong trang (theo `location.hostname` của document đã commit) trước mỗi lệnh `page.js` và `browser_eval`. `browser_screenshot` kiểm tra lại tab đang hiển thị trước khi chụp. Nếu một click hoặc redirect đưa tab sang domain không được phép, bước đó hỏng và snapshot của trang đó không được đọc.
- `browser_eval` chạy JS tuỳ ý trong phiên đăng nhập của bạn. Chỉ bật server khi cần, và duyệt kỹ các bước gửi, xoá hoặc thanh toán (cơ chế xác nhận của Claude Code).
- Prompt injection: nội dung trang có thể chứa chỉ dẫn nhắm vào AI. Allowlist giới hạn phạm vi, nhưng vẫn nên đọc kỹ trước khi duyệt các hành động nhạy cảm.
- Workflow lưu dạng plaintext trong `~/.fast-browser/workflows`. Giá trị điền vào ô mật khẩu không bao giờ được ghi xuống đĩa: recording, file workflow và log chỉ chứa `{{password}}` hoặc số ký tự. Locator không dùng thuộc tính `value` của ô nhập liệu (chỉ dùng cho radio/checkbox), và với ô mật khẩu server bỏ hẳn selector có `[value=…]`.
- Chỉ một extension (đã xác thực) kết nối tại một thời điểm (kết nối đã xác thực mới nhất thắng).
- Đường `/peer` (cho server của session khác) chỉ nhận kết nối **không có** header `Origin` (trình duyệt luôn gửi, nên trang web không vào được) và phải qua bắt tay HMAC bằng cùng token, với tiền tố khác của extension nên không dùng lại proof được. Peer kiểm tra primary trước, nên tiến trình lạ chiếm cổng không nhận được lệnh nào.

## Giới hạn của giai đoạn 1

- Click và phím là sự kiện giả lập (`isTrusted = false`, không dùng CDP). Một số trình soạn thảo, nút thanh toán và captcha không phản hồi. Riêng phím `Escape` trên `<dialog>` native được giả lập bằng `cancel` + `close()`.
- Hộp thoại `alert` / `confirm` / `prompt` chặn trang: bước đó bị timeout, cần bấm tay.
- Chưa tìm phần tử trong iframe và shadow DOM.
- `browser_eval` bị chặn trên trang có CSP không cho `unsafe-eval`. Khi đó dùng `browser_extract` hoặc `browser_snapshot`.
- Nhiều session (nhiều cửa sổ Claude Code, Claude Desktop) dùng chung một extension: server mở trước giữ cổng (primary), server mở sau tự nối vào nó qua `/peer` và chuyển lệnh qua đó. Primary thoát thì một peer tự lên thay, extension tự nối lại. Mỗi session tự nhớ tab của mình; khi đang dùng chung mà session chưa có tab riêng, `browser_snapshot`/`browser_act`/… không kèm `tabId` bị từ chối và `browser_tabs goto` mở tab mới thay vì điều hướng tab của session khác. Hai session cố tình truyền cùng một `tabId` thì vẫn giẫm lên nhau.
- Nếu cổng bị tiến trình khác (không phải Fast Browser, hoặc khác token) chiếm, mọi tool trả lỗi `port 17890 in use — … (could not share it: …)`. Khi đó đặt `FB_PORT` khác, và đổi cổng tương ứng trong popup.
- Selector đã ghi có thể hỏng khi web đổi giao diện. Locator được lấy **trước** khi thực hiện hành động (nút đổi tên "Show more" → "Show less" vẫn replay được). Khi replay, tên phần tử được kiểm tra và tự rơi về tìm theo role + tên. Nếu vẫn không thấy, bước đó báo hỏng để sửa.
- `check` chờ tối đa 500ms để framework (React 18, Vue) cập nhật trạng thái sau sự kiện click trước khi báo lỗi.
- `press` với phím in được / `Backspace` / `Delete` tôn trọng vùng chọn: `Control+a` rồi gõ phím sẽ thay toàn bộ nội dung.
- Trang có DOM thay đổi liên tục làm bước chờ ổn định chạm trần 2,5s. Đặt `noWait: true` cho bước đó để bỏ qua.
- Không dùng được trên claude.ai web (cần remote MCP), không giải captcha, không hỗ trợ trình duyệt khác Chrome/Chromium.
- `<select multiple>` chỉ chọn được một giá trị. Modal "trên cùng" là modal hiển thị cuối cùng trong DOM, không xét z-index.

## Phát triển và test

```bash
npm test            # unit test: server (node:test + fake extension) và extension (jsdom cho page.js, fake chrome cho runner.js)
npm run test:e2e    # Playwright Chromium + extension thật + MCP server thật qua stdio + trang fixture local
```

E2E chạy Chromium ở chế độ headless mới (`channel: 'chromium'`, có hỗ trợ extension). Đặt `FB_E2E_HEADED=1` để xem trình duyệt. Cần cài Chromium của Playwright một lần: `npx playwright install chromium`. Test không truy cập mạng ngoài `127.0.0.1`. Bộ test tự cấp cổng trống cho server qua `FB_PORT`, tạo sẵn `FB_HOME/token`, rồi ghi cổng và token vào `chrome.storage.local` của extension qua service worker.
