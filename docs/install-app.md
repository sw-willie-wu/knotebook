# Installing Knotebook as an app

Knotebook can be added to a phone's or computer's home screen, or installed from the browser, and
then opens in its own window without the browser's address bar. It is the same web app as in a
browser tab: it needs the server just like the tab does, and it is updated whenever the server is.

## Android (Chrome)

1. Open your Knotebook site in Chrome and sign in.
2. Open Chrome's **⋮** menu and choose **Add to home screen** (or **Install app**). Chrome may also
   offer it at the bottom of the screen on its own.
3. Confirm. Knotebook appears on the home screen and in the app drawer with the "K" icon.

The installed app always opens in portrait.

## iPhone and iPad (Safari)

1. Open your Knotebook site in Safari and sign in.
2. Tap **Share**, then **Add to Home Screen**.
3. Tap **Add**.

iOS doesn't lock the app to portrait: turned sideways, it shows the landscape layout.

## Computer (Chrome, Edge)

Open your Knotebook site and use the install icon at the right end of the address bar, or **Install
Knotebook** in the browser's menu. Knotebook then opens in its own window and can be pinned to the
taskbar or dock.

## Things to know

- **Installing needs HTTPS in Chrome and Edge.** Chromium-based browsers only offer to install a site
  served over HTTPS (or opened from `localhost`). On a plain-http deployment they don't offer it; see
  [Known limitations](./known-limitations.md).
- **Not offline.** The app has no offline copy of the site or of your notes. Opening it without a
  connection shows the browser's or the system's error page. A note that was already open behaves as
  it does in a browser tab: you can keep editing, and your changes sync when the connection comes
  back, but they are lost if you close the app before that.
- **Updates.** Starting the app always loads the current version. If the app has been left in the
  background and the site has been updated since, coming back to it shows **Knotebook has been
  updated** with a **Reload** button; it doesn't reload by itself, so nothing you're typing is
  interrupted.
- **Top bar colour.** In browsers that colour the window's top bar, it follows the theme you pick in
  **Settings**, once the app has started.
- **Public links.** A public share page (`/p/…`) doesn't offer to install Knotebook: installing
  from there would only open the sign-in page.
