package ai.deepseek.tablet;

/** Controls just the DSH process started by this app under the SSH account. */
final class SshManagedDsh {
    private SshManagedDsh() {}

    static String command(boolean restart, String executable) {
        return "sh -lc " + quote(SCRIPT) + " chatpad "
                + (restart ? "restart " : "reuse ") + quote(executable);
    }

    private static String quote(String value) {
        // Keep the login shell's treatment of literal quotes and backslashes outside quoted spans.
        return "'" + value.replace("\\", "'\\\\'").replace("'", "'\\''") + "'";
    }

    private static final String SCRIPT = """
            set -eu
            umask 077
            action=$1
            executable=$2
            state="$HOME/.deepseek-chat-pad-remote"
            [ ! -L "$state" ] || exit 70
            mkdir -p "$state"
            chmod 700 "$state"
            mkdir "$state/lock" 2>/dev/null || { echo CHATPAD:BUSY; exit 73; }
            trap 'rmdir "$state/lock" 2>/dev/null || true' EXIT
            trap 'exit 1' HUP INT TERM

            process_start() {
              if [ -r "/proc/$1/stat" ]; then
                status=$(cat "/proc/$1/stat") || return 1
                fields=${status##*) }
                set -- $fields
                [ "$#" -ge 20 ] && [ "$1" != Z ] || return 1
                shift 19
                echo "$1"
              else
                LC_ALL=C ps -p "$1" -o lstart= 2>/dev/null
              fi
            }
            same_process() {
              observed=$(process_start "$pid") || return 1
              [ -n "$observed" ] && [ "$observed" = "$started" ]
            }
            launch_url() {
              LC_ALL=C grep -Eo 'http://127[.]0[.]0[.]1:[0-9]+/[?]token=[^[:space:]&#]+' "$state/web.log" 2>/dev/null | tail -n 1
            }

            if [ -f "$state/process" ]; then
              { IFS= read -r pid && IFS= read -r started && IFS= read -r previous; } < "$state/process" || exit 70
              case "$pid" in ''|0|1|*[!0-9]*) exit 70;; esac
              [ -n "$started" ] || exit 70
              if same_process; then
                if [ "$action" = restart ]; then
                  kill -TERM "$pid"
                  tries=0
                  while same_process && [ "$tries" -lt 10 ]; do
                    sleep 1
                    tries=$((tries + 1))
                  done
                  if same_process; then echo CHATPAD:STILL_RUNNING; exit 73; fi
                else
                  url=$(launch_url)
                  if [ "$previous" != "$executable" ] || [ -z "$url" ]; then
                    echo CHATPAD:STILL_RUNNING
                    exit 73
                  fi
                  echo "CHATPAD:URL $url"
                  exit 0
                fi
              fi
            fi

            if [ "$executable" = dsh ] && ! command -v dsh >/dev/null 2>&1; then
              for bin in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin" \
                         "$HOME/.bun/bin" "$HOME/Library/pnpm" "$HOME/.local/share/pnpm" \
                         /usr/local/bin /opt/homebrew/bin "$HOME"/.nvm/versions/node/*/bin; do
                if [ -x "$bin/dsh" ]; then PATH="$bin:$PATH"; export PATH; break; fi
              done
            fi
            command -v "$executable" >/dev/null 2>&1 || { echo CHATPAD:DSH_MISSING; exit 127; }
            NO_COLOR=1
            export NO_COLOR
            nohup "$executable" web --host 127.0.0.1 --port 0 --no-open > "$state/web.log" 2>&1 </dev/null &
            pid=$!
            started=$(process_start "$pid")
            [ -n "$started" ] || exit 70
            printf '%s\n' "$pid" "$started" "$executable" > "$state/process.pending"
            mv -f "$state/process.pending" "$state/process"
            tries=0
            while [ "$tries" -lt 30 ] && same_process; do
              url=$(launch_url)
              if [ -n "$url" ]; then
                echo "CHATPAD:URL $url"
                exit 0
              fi
              tries=$((tries + 1))
              sleep 1
            done
            exit 70
            """;
}
