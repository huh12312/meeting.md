# meeting.md desktop app

The desktop client for [meeting.md](../README.md): records a meeting, shows live
transcription and suggestions, and produces a summary afterwards. It talks to a
meeting.md server you run yourself.

This is a fork of [Call.md](https://github.com/video-db/call.md) by VideoDB
(declared MIT in its `package.json`). Changes from upstream: a configurable
backend URL, recording on Linux, fixes to the setup wizard and live assist, and
the removal of VideoDB-specific branding, links and credentials.

```sh
npm install        # on Linux this also installs the capture helper
npm run dev        # or: npm run dist:linux / dist:mac / dist:win
```

- **Backend URL:** `MEETING_MD_API_URL`, or `runtime.json` in the user data
  directory, or the bundled `runtime.json` (`http://localhost:8080`).
- **Google Calendar (optional):** no OAuth client ships with the app. Create
  your own in Google Cloud and save it as `google_oauth.json` in the user data
  directory; `resources/google_oauth.example.json` shows the format.
- **Recording on macOS and Windows** uses VideoDB's capture binary, which the
  `videodb` npm package downloads at install time. It is not part of this
  repository.

See the [top-level README](../README.md) for the server, configuration and
what has and has not been tested.
