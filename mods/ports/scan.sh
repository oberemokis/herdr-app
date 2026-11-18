# Who listens on TCP ports, in sections the mod's scan.js parses.
L=$(lsof -nP -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null)
echo "@home"; echo "$HOME"
echo "@lsof"; echo "$L"
P=$(echo "$L" | sed -n 's/^p//p' | sort -u | paste -sd, -)
[ -z "$P" ] && exit 0
echo "@ps"; ps -o pid=,ppid=,etime=,command= -p "$P"
C=$(lsof -a -d cwd -p "$P" -Fpn 2>/dev/null)
echo "@cwd"; echo "$C"
echo "@tree"; ps -axo pid=,ppid=,comm=
# Published container ports belong to the Docker VM's process; ask Docker whose they are.
D=""
if echo "$L" | grep -qiE '^c(OrbStack|com\.docker|vpnkit|docker|limactl|gvproxy)'; then
  D=$(docker ps --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Ports}}' 2>/dev/null)
  echo "@docker"; echo "$D"
fi
echo "@git"; { echo "$C" | sed -n 's/^n//p'; echo "$D" | cut -d'|' -f3; } | sort -u | while IFS= read -r d; do
  [ -z "$d" ] || [ "$d" = / ] && continue
  r=$(git -C "$d" rev-parse --path-format=absolute --show-toplevel --git-common-dir --abbrev-ref HEAD 2>/dev/null | paste -sd'|' -)
  [ -n "$r" ] && printf '%s|%s\n' "$d" "$r"
done
# Compose folders that no longer exist: a container outliving its worktree.
echo "@gone"; echo "$D" | cut -d'|' -f3 | sort -u | while IFS= read -r d; do
  [ -n "$d" ] && [ ! -d "$d" ] && echo "$d"
done
