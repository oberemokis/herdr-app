#!/usr/bin/env bash
# Ставит моды и раскладку workbench в Herdr.app.
# Перед заменой кладёт копию прежних файлов в ~/.local/share/herdr-app-backups/<время>.
# Моды Herdr не трогает: свои имена с ними не совпадают, иначе Herdr затёр бы их при старте.
#
#   scripts/install.sh            поставить
#   scripts/install.sh --dry-run  только показать, что изменится
#
# HERDR_APP_HOME выбирает папку Herdr (по умолчанию ~/.config/herdr-app).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
BACKUP=$HOME/.local/share/herdr-app-backups/$(date +%Y%m%d-%H%M%S)
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" = 1 ]; then say "  [dry-run] $*"; else "$@"; fi; }

for tool in herdr-app jq node rsync; do
  command -v "$tool" >/dev/null || { echo "Не найден $tool" >&2; exit 1; }
done
[ -d "$HOME_DIR/mods" ] || { echo "Нет $HOME_DIR/mods: Herdr ещё не запускался" >&2; exit 1; }

mods=()
for dir in "$REPO"/mods/*/; do mods+=("$(basename "$dir")"); done

# Имена модов Herdr: installed.json ведёт сам Herdr, ключи без префикса layout: это моды.
shipped=$(jq -r 'keys[] | select(startswith("layout:") | not)' "$HOME_DIR/installed.json")
for mod in "${mods[@]}"; do
  if grep -qx "$mod" <<<"$shipped"; then
    echo "Имя мода $mod занято модом Herdr, переименуй папку в mods/" >&2
    exit 1
  fi
done

say "Резервная копия: $BACKUP"
run mkdir -p "$BACKUP/mods" "$BACKUP/layouts" "$BACKUP/themes"
for mod in "${mods[@]}"; do
  if [ -d "$HOME_DIR/mods/$mod" ]; then run cp -R "$HOME_DIR/mods/$mod" "$BACKUP/mods/"; fi
done
for layout in "$REPO"/layouts/*.json; do
  name=$(basename "$layout")
  if [ -f "$HOME_DIR/layouts/$name" ]; then run cp "$HOME_DIR/layouts/$name" "$BACKUP/layouts/"; fi
done
for theme in "$REPO"/themes/*.json; do
  name=$(basename "$theme")
  if [ -f "$HOME_DIR/themes/$name" ]; then run cp "$HOME_DIR/themes/$name" "$BACKUP/themes/"; fi
done
if [ -f "$HOME_DIR/keys.json" ]; then run cp "$HOME_DIR/keys.json" "$BACKUP/"; fi

say "Моды:"
for mod in "${mods[@]}"; do
  say "  $mod"
  # cache/ better-files и файлы, которые Herdr пишет сам, не удаляются и не перезаписываются.
  run rsync -a --delete --exclude cache/ --exclude gpui-kit.d.ts --exclude jsconfig.json \
    "$REPO/mods/$mod/" "$HOME_DIR/mods/$mod/"
done

# Темы раньше раскладок: раскладку с ещё не существующей темой Herdr не применяет.
say "Темы:"
run mkdir -p "$HOME_DIR/themes"
for theme in "$REPO"/themes/*.json; do
  say "  $(basename "$theme")"
  run cp "$theme" "$HOME_DIR/themes/"
done

say "Раскладки:"
for layout in "$REPO"/layouts/*.json; do
  say "  $(basename "$layout")"
  run cp "$layout" "$HOME_DIR/layouts/"
done

say "Клавиши:"
for keys in "$REPO"/keys/*.json; do
  if [ "$DRY" = 1 ]; then
    node "$REPO/scripts/merge-keys.mjs" --dry-run "$keys" "$HOME_DIR/keys.json"
  else
    node "$REPO/scripts/merge-keys.mjs" "$keys" "$HOME_DIR/keys.json"
  fi
done

if [ "$DRY" = 1 ]; then
  say "Проверка модов пропущена в --dry-run"
  exit 0
fi

say "Проверка модов:"
failed=0
for mod in "${mods[@]}"; do
  herdr-app check "$HOME_DIR/mods/$mod" || failed=1
done
[ "$failed" = 0 ] || { echo "Часть модов не прошла herdr-app check" >&2; exit 1; }

say ""
say "Готово. Включить раскладку: herdr-app do layout.switch --name workbench"
say "Назад: ctrl-shift-l или herdr-app do layout.switch --name main"
