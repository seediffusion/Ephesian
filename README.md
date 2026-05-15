# Ephesian

Document collaboration that unifies and empowers.

Ephesian is a Google-Docs-style platform you can run on your own machine or server. It pairs real-time co-editing with a web interface that has been audited for screen readers such as [NVDA](https://nvaccess.org/about-nvda/) and JAWS, light and dark mode, full keyboard operation, and standards-based two-factor authentication. There is no external service to sign up for, no database to install, and no telemetry. Everything lives in one Node.js process and a single SQLite file.

## Why "Ephesian"?

The name is borrowed from the New Testament Letter to the Ephesians, which  teaches unity of the Jews and the Gentiles (non-Jews) through Jesus Christ. The project has nothing to do with religion; the theme is simply that a collaboration tool aims to unify everyone around a shared project idea.

## Ephesian features

Ephesian is a fully-featured document collaboration tool. You can create documents, edit them together with other people in real time, see each other's cursors, share documents by email or by invite link, set a limit on how many people can be inside a single document at once, import and export Microsoft Word, HTML, Markdown, and plain text, and keep working in the browser when you lose your network connection — Ephesian syncs your changes back to the server as soon as you reconnect. Accounts are protected with argon2id password hashing, email verification, secure password reset links, and a choice of two-factor methods including authenticator apps, security keys and passkeys, email codes, and one-time backup codes. SMS is not supported, by design.

## Running Ephesian

### from source

Ephesian is written in JavaScript and uses [Node.js](https://nodejs.org/), version 18.17 or newer. You will also need [Git](https://git-scm.com/) installed. These instructions apply to Windows, macOS, and Linux.

1. Install Node.js from [nodejs.org](https://nodejs.org/). The current LTS release is fine.
2. Open a terminal. On Windows, press Windows + R, type powershell, and press Enter.
3. Clone this repository with git by running the following command.
```
git clone https://github.com/seediffusion/ephesian.git
```
4. Move into the Ephesian folder and install the libraries needed for Ephesian.
```
cd ephesian
npm install
```
5. Start Ephesian.
```
npm start
```

The first start creates a `.env` file from `.env.example`, generates a random session secret, builds the frontend bundle, and creates the SQLite database in the `data` folder. You do not have to do any of this yourself. The terminal prints the URL to open, by default <http://localhost:8787>.

### Configured

If you would like to be walked through the configuration in plain English rather than editing `.env` by hand, run the setup wizard. The wizard asks for the port, public URL, SMTP details, and a few other values, then writes a working `.env` for you.

```
npm run setup
```

Re-run the wizard any time to change settings.

### Development mode

To run Ephesian with the frontend bundler watching for changes, use development mode.

```
npm run dev
```

The bundler rebuilds `public/dist/main.js` whenever you edit a file in `public/src`, and the server restarts on its own.

## Email setup

Ephesian uses email to deliver account verification codes, password reset links, second-factor codes for users who have enabled email 2FA, and invite links for people you share documents with. Configuring email is optional. If you do not configure SMTP, Ephesian prints every email to the terminal instead of sending it. This is the simplest configuration and is perfectly fine for solo or testing use — you just copy the verification code or reset link out of the terminal window.

When you are ready to use a real provider, fill in the SMTP variables in `.env`:

```
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=you@your-provider.com
SMTP_PASS=app-password-here
SMTP_SECURE=false
SMTP_FROM=Ephesian <no-reply@your-domain.com>
```

The setup wizard walks you through these.

## Creating an account

When you open Ephesian for the first time, you will be greeted with a landing page.

1. Tab to Create an account and press Space or Enter.
2. Enter your email address, an optional display name, and a password. Passwords must be at least 10 characters and contain upper case, lower case, and a number. Pasting from a password manager is supported.
3. Tab to the Create account button and press Space or Enter.
4. Ephesian sends a 6-digit verification code to your email address (or prints it to the terminal if SMTP is not configured). Enter the code in the next dialog and press Enter.

After verifying your email you are dropped on the documents dashboard. From here you can create new documents, import files, and open existing ones.

## Resetting a forgotten password

From the sign-in page, choose "Forgot your password?", enter the email address for the account, and press Send reset link. Ephesian always shows the same response for valid-looking email addresses so account existence is not exposed. If the account exists, Ephesian sends a one-time reset link that expires after 1 hour.

Opening the link lets you choose a new password. After a successful reset, all existing sessions for that account are signed out, old reset links are invalidated, and the account email is treated as verified because the reset link proves access to the registered mailbox.

When SMTP is configured, reset links are sent by SMTP and are not printed to the terminal. The server log records password reset delivery diagnostics, including whether SMTP accepted or rejected the message, without logging the reset token or reset URL.

## Creating and editing documents

1. From the dashboard, press the New document button. Enter a title and, if you want, a collaborator limit (0 means unlimited). Press Create.
2. The editor opens with an empty document. Start typing.
3. The editor saves automatically. The connection status at the top of the page tells you when Ephesian is connected to the server and auto-saving, when you are working offline, and when changes have been synced.

The formatting toolbar above the editing area lets you toggle bold, italic, underline, strikethrough, and inline code; switch between paragraph and heading levels 1 through 3; insert bullet, numbered, and task lists; insert blockquotes, horizontal rules, links, and tables; and undo or redo. Each button has a descriptive accessible name including its keyboard shortcut where applicable, E.G. Bold (Ctrl + B). Tab moves into the toolbar and the arrow keys move between buttons inside it, following the standard ARIA toolbar pattern.

To change a document's title, click or focus the title field at the top of the editor and type. Title changes are saved automatically.

## Sharing documents

There are two ways to share a document. Both require that you own the document.

### Sharing by email

1. Open the document.
2. Press the Share button.
3. In the Invite by email section, enter the email address of the person you want to share with and choose Editor or Viewer from the Role dropdown.
4. Press Send invitation.

If the recipient already has an Ephesian account, they gain access immediately and an email tells them the document is now available. If they do not have an account yet, they receive an email with an invite link that can be accepted by signing up with the same email address.

### Sharing by invite link

Invite links work even when you do not know the recipient's email address.

1. Open the document and press the Share button.
2. In the Invite links section, choose Editor or Viewer, optionally set a maximum number of uses (0 means unlimited), and decide whether to allow joining as a guest (see below). Press Create invite link.
3. The link is created and copied to your clipboard automatically.
4. Share the link however you like (chat, email, paper).

You can revoke a link from the same dialog at any time. Revoking does not remove people who have already accepted; it only stops new people from using the link.

### Guest access

By default, anyone who opens an invite link or an email invitation can join the document immediately as a **guest** by entering a display name. They do not need an Ephesian account, an email address, or a password. Guests get the role chosen on the invite (editor or viewer) and behave exactly like any other collaborator while they are connected, including showing up in the presence list (with a dashed avatar border and a small "G" badge) and counting toward the document's collaborator limit. Screen readers announce guests as "Name (editor, guest)" or similar.

Guest access is per-invite. When you create an invite link or send an email invitation in the Share dialog, you will see an "Allow joining as a guest (no account required)" checkbox. Leave it on (the default) to let the recipient choose; uncheck it to require them to sign in or create an Ephesian account first. For email invitations, only the matching email address can sign in to accept; the guest path is a separate option that does not need to match.

A guest session lasts for the browser session only. If a guest closes the tab, returns the next day, and opens the same link, they re-enter their display name and start a fresh guest session. Their previous in-document edits are preserved in the document itself — they just no longer have access through that earlier guest identity. If a guest wants to come back as themselves later, they can press Create an account in the header at any time during their guest session.

Guests cannot create their own documents, cannot share documents they have been invited to, and cannot manage 2FA.

## Setting a collaborator limit

Each document has a collaborator limit which controls how many distinct people can be inside the document at the same time. The default is unlimited (0). Anyone who tries to join while the document is full is politely told the document is at capacity and asked to try again later, or to ask the owner to raise the limit.

To set or change a document's limit:

1. Open the document and press the Share button.
2. Scroll to the Capacity limit section.
3. Enter a number and press the Update button.

Tabs from the same user count as one person, so opening a document in two browser tabs does not consume two slots. Each guest counts as a separate person because their session is scoped to that one browser tab.

## Importing and exporting

Ephesian can import and export Microsoft Word (.docx), HTML, Markdown (.md), and plain text (.txt) files.

### Importing

To import a file as a new document, press the Import a file button on the dashboard. Pick a file and Ephesian creates a new document with the file's contents and opens it.

To replace an existing document's contents with the contents of a file, open the document and press the Import button in the toolbar at the top. You will be asked to confirm because this overwrites the current content for everyone in the document.

### Exporting

To export the document you are currently editing, press the Export button at the top of the editor. Pick a format from the dialog: Microsoft Word, HTML, Markdown, or plain text. Ephesian generates the file and downloads it.

## Working offline

If you lose your network connection while editing a document, you can keep typing. Ephesian stores your changes in your browser's IndexedDB store and the connection-status indicator above the editor switches to Offline. When the network comes back, your changes sync back to the server automatically and merge with anything that happened while you were away. The merge is conflict-free, because Ephesian uses [Y.js](https://docs.yjs.dev/) CRDTs under the hood.

If you close the tab while offline, your changes are still saved locally and will sync the next time you open the document.

## Two-factor authentication

To turn on two-factor authentication, select your name in the top right of the header to open your account page, then scroll to the Two-factor authentication section. SMS is intentionally not supported.

* **Authenticator app (TOTP)**: press Enable, scan the QR code with an authenticator app such as Aegis, 1Password, Bitwarden, or Google Authenticator, then enter the 6-digit code the app generates to confirm. Ephesian also generates 10 one-time backup codes on first set-up. Save them — they can be used to sign in if you lose access to your authenticator.
* **Security key or passkey (WebAuthn)**: press Add a key, give the key a name, and follow your browser's prompts. This works with hardware keys such as YubiKeys, with platform passkeys (Windows Hello, Touch ID, Android), and with passkey-syncing password managers.
* **Email-based codes**: press Enable. When you sign in, Ephesian will email you a one-time code in addition to asking for your password.
* **Backup codes**: a set of 10 single-use codes you can save somewhere safe. Press the Generate or replace backup codes button to make a new set. Old codes stop working immediately.

You can enable any combination of factors. At sign-in time you will be offered a choice between every factor you have enabled.

## Dark mode

Ephesian has light, dark, and automatic modes. Press the theme toggle button in the top right of every page to cycle between them. The current state is announced to screen readers, E.G. "Theme: light. Activate to switch to dark." In automatic mode, Ephesian follows the operating system's light/dark preference and switches with it. Your choice is remembered between visits.

## Settings

Open the `.env` file in your Ephesian folder to configure the following:

* `PORT`: the HTTP port Ephesian listens on. Default 8787.
* `WS_PORT`: an optional separate port for the real-time WebSocket. Leave blank to share `PORT`.
* `PUBLIC_ORIGIN`: the public URL Ephesian is reachable at, used to construct invite links and email content. Default `http://localhost:$PORT`.
* `SESSION_SECRET`: an HMAC key for session cookies. Generated automatically on first run.
* `COOKIE_SECURE`: set to true when serving over HTTPS so cookies receive the Secure flag.
* `TRUST_PROXY`: set to true when Ephesian is behind a reverse proxy that sets X-Forwarded-* headers.
* `PASSWORD_RESET_REQUEST_IP_MAX`, `PASSWORD_RESET_REQUEST_IP_WINDOW_MS`: maximum reset-link requests per IP address in the configured window. Defaults to 10 per hour.
* `PASSWORD_RESET_REQUEST_EMAIL_MAX`, `PASSWORD_RESET_REQUEST_EMAIL_WINDOW_MS`: maximum reset-link requests per email address in the configured window. Defaults to 5 per hour.
* `PASSWORD_RESET_CONFIRM_IP_MAX`, `PASSWORD_RESET_CONFIRM_IP_WINDOW_MS`: maximum reset attempts per IP address in the configured window. Defaults to 20 per 15 minutes.
* `DATABASE_PATH`: where the SQLite file lives. Default `./data/ephesian.db`.
* `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_FROM`: email server credentials. Leave `SMTP_HOST` blank to print emails to the terminal instead of sending them.
* `APP_NAME`: the application name shown in the header. Default Ephesian.
* `WEBAUTHN_RP_NAME`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`: WebAuthn relying-party identity. Default to values derived from `PUBLIC_ORIGIN`.
* `DEFAULT_DOCUMENT_CAPACITY`: the default capacity for documents whose owner did not set one. Default 0 (unlimited).

Re-run `npm run setup` to be guided through these settings in plain English.

## Accessibility

Ephesian has been rigorously tested to ensure it is as accessible as possible for users with disabilities.

* Every input has a programmatic label.
* Every on-screen element, be it a button, a text field, or a checkbox, has a clear screen reader label.
* Modal dialogs keep focus and gracefully restore it when closed.
* The formatting toolbar follows the ARIA toolbar pattern with arrow-key navigation.
* Route changes are announced to screen readers, including the new page title.
* Connection status updates are politely live-regioned and debounced, so screen readers are not constantly interrupted or spammed.
* Presence updates announce who joined and left, with natural pluralisation.
* Guests are clearly marked in the presence list both visually (dashed avatar border and "G" badge) and to assistive technology (the suffix "(guest)" is spoken).
* Colour contrast meets WCAG 2.2 AA in both light and dark themes, and focus indicators are visible against every background including the accent-coloured active toolbar buttons.
* Two-factor authentication offers a WebAuthn option which satisfies WCAG 3.3.8 Accessible Authentication without requiring users to remember anything.

## HTTPS and production

Ephesian itself only speaks HTTP. For HTTPS, put it behind a reverse proxy such as Caddy, nginx, or Traefik, and set the following in your `.env`:

```
COOKIE_SECURE=true
TRUST_PROXY=true
PUBLIC_ORIGIN=https://your-domain.com
```

A minimal Caddyfile looks like this:

```
your-domain.com {
  reverse_proxy localhost:8787
}
```

Caddy handles the TLS certificate for you. Other reverse proxies work the same way.

## Backup and restore

All of your data — accounts, documents, sessions, invite links, and 2FA secrets — lives in two places.

* The SQLite database at `data/ephesian.db`.
* The `.env` file at the root of the Ephesian folder.

To back Ephesian up, stop the server and copy these two files (and the `data` folder, which includes WAL files for in-flight transactions). To restore, copy them back and start the server again. To move to a new machine, copy these to the new machine, run `npm install`, then `npm start`.

## Building

The frontend bundle is built automatically on first start. To rebuild it manually:

```
npm run build
```

The output is placed in `public/dist/main.js`. The server serves it from there.

## Debugging

Ephesian writes the terminal output you see when running `npm start` to standard output. To capture it to a file:

```
npm start > ephesian.log 2>&1
```

The SQLite database is a normal SQLite file. You can open it with the `sqlite3` command-line tool or any GUI client such as [DB Browser for SQLite](https://sqlitebrowser.org/) to inspect tables, run queries, or recover data.

If the frontend does not load, delete `public/dist` and run `npm run build` again. If the server refuses to start because of a database error, delete the `data` folder (this wipes all data) and start again to get a fresh database.
