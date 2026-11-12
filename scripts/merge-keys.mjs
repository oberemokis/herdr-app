// Добавляет клавиши репозитория в keys.json Herdr, не заменяя чужие.
// Занятая клавиша с другим действием остаётся как есть и попадает в отчёт:
// решать, что важнее, должен человек, а не скрипт.
//
//   node scripts/merge-keys.mjs [--dry-run] <наши keys.json> <keys.json Herdr>
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const dry = args[0] === "--dry-run";
const [oursPath, theirsPath] = dry ? args.slice(1) : args;
if (!oursPath || !theirsPath) {
  console.error("usage: merge-keys.mjs [--dry-run] <ours.json> <keys.json>");
  process.exit(2);
}

const ours = JSON.parse(readFileSync(oursPath, "utf8"));
const theirs = existsSync(theirsPath) ? JSON.parse(readFileSync(theirsPath, "utf8")) : {};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let added = 0;
const kept = [];
for (const [section, keys] of Object.entries(ours)) {
  theirs[section] ??= {};
  for (const [key, action] of Object.entries(keys)) {
    const current = theirs[section][key];
    if (current === undefined) {
      theirs[section][key] = action;
      added++;
      console.log(`  + ${section} ${key} → ${JSON.stringify(action)}`);
    } else if (!same(current, action)) {
      kept.push(`  ! ${section} ${key}: оставлено ${JSON.stringify(current)}, наше ${JSON.stringify(action)}`);
    }
  }
}
for (const line of kept) console.log(line);
if (!added) console.log("  новых клавиш нет");
if (dry || !added) process.exit(0);

// Атомарно: Herdr читает файл на лету, и наполовину записанный JSON он бы отверг.
const tmp = `${theirsPath}.tmp-${process.pid}`;
writeFileSync(tmp, `${JSON.stringify(theirs, null, 2)}\n`);
renameSync(tmp, theirsPath);
