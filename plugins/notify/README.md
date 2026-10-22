# notify — ntfy push when a model's generation ends

A long agent run is invisible from the outside: the terminal looks the same
whether the model is still thinking or has finished. This plugin watches the
server event stream, measures the run, and publishes one message per finished
generation, so a long run can be checked from a phone.

The notification title is the **chat title**, so the phone shows which
conversation finished without opening anything.

## Install

```sh
cp -r plugins/notify ~/.config/opencode/plugins/notify
```

Restart the service (`opencode service restart`). The plugin needs no
credentials: it publishes to a public ntfy topic.

## Configure

Settings come from three places. The first one that holds a usable value
wins:

1. **Plugin options** in `opencode.json`
2. **Environment variables**
3. **The config file** `~/.config/opencode/notify.json`
4. The built-in defaults

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `server` | `OPENCODE_NTFY_SERVER` | `https://ntfy.sh` | ntfy server. A path prefix is kept, so a self hosted server behind a reverse proxy works. |
| `topic` | `OPENCODE_NTFY_TOPIC` | `theblackcat` | ntfy topic. Letters, numbers, `_` and `-`, up to 64 characters. |
| `token` | `OPENCODE_NTFY_TOKEN` or `NTFY_TOKEN` | none | Access token for a private topic. Sent as `Authorization: Bearer`. |
| `priority` | `OPENCODE_NTFY_PRIORITY` | `default` | ntfy priority: `min`, `low`, `default`, `high`, `max`. |
| `minDurationSec` | `OPENCODE_NTFY_MIN_SECONDS` | `0` | Report only runs that lasted at least this long. `0` reports every run. |
| `includeSubagents` | `OPENCODE_NTFY_INCLUDE_SUBAGENTS` | `false` | Also report subagent sessions. |
| `allLocations` | `OPENCODE_NTFY_ALL_LOCATIONS` | `false` | Report sessions of every project, not only the one this instance was loaded for. |
| `configFile` | `OPENCODE_NTFY_CONFIG` | `~/.config/opencode/notify.json` | Path of the config file. |

### The config file

The config file is the way to configure a plugin that was installed as a
directory, because `opencode.json` has no entry for it and holds no options.

```json
{
  "server": "https://ntfy.sh",
  "topic": "my-topic",
  "token": "tk_xxxxx",
  "priority": "high",
  "minDurationSec": 300
}
```

A missing file is normal. A broken file is reported in the log and ignored, so
a typo never stops the plugin from loading.

The file is read again for every run, so a change applies to the next
notification without a restart.

The file holds a token in plain text. Keep it readable by the owner only
(`chmod 600 ~/.config/opencode/notify.json`).

### Plugin options

Listing the plugin in `opencode.json` gives it the same settings:

```jsonc
{
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/notify",
      "options": {
        "server": "https://ntfy.sh",
        "topic": "my-topic",
        "minDurationSec": 300
      }
    }
  ]
}
```

A plugin that is both listed here and discovered in the plugins directory is
loaded twice for the same location. The last instance takes ownership of the
location, so a run is still reported once.

## What is reported

- The trigger is the server's `session.execution.*` events, the same ones the
  built-in terminal notification uses. The run length is measured from
  `session.execution.started` to the terminal event.
- A finished run is reported as `finished`, a failed one as `failed`, and a
  stopped one as `stopped`. A user interrupt (escape) is not reported.
- The body carries the outcome, the run length and the directory. The title
  carries the chat title.
- A session is reported by the plugin instance that owns its project, so one
  run is one message even when several projects are open.

## Privacy

The topic is public by default: a topic name is the only secret, and anyone
who guesses it can read the messages. The message holds the chat title, the
outcome, the run length and the directory. Nothing else is sent.

Use a private topic with a token when the titles are sensitive.

## Notes

- The title is RFC 2047 encoded when it is not plain ASCII, because an HTTP
  header cannot carry arbitrary UTF-8.
- ntfy.sh accepts the message as plain text with the title in a header. The
  JSON publishing format is not accepted by ntfy.sh.
- A failed notification never breaks the session. It is logged and the run
  continues.
