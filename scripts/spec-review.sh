#!/usr/bin/env sh
# Запускає рецензента специфікації (spec-ambiguity-reviewer) в ІЗОЛЬОВАНОМУ
# checkout'і.
#
# Правило рецензента «ніколи не читай реалізацію» нічого не варте як інструкція
# в промпті: агент має Read/Grep/Glob/Bash, і ніщо не заважає йому відкрити
# app/src/discounts.ts та розв'язати неоднозначність за кодом замість того, щоб
# про неї повідомити. Цей скрипт робить правило структурним — реалізації немає
# в дереві, проти якого агент працює, а зверху на це накладено заборону шляхів.
#
#   sh scripts/spec-review.sh          # зібрати пісочницю, перевірити, показати команду
#   sh scripts/spec-review.sh --run    # ще й запустити рецензента в ній
#
# Завершується ненульовим кодом, якщо ізоляцію не вдалося довести: зламану
# пісочницю не можна сплутати з чистим рев'ю.

set -eu

REPO_ROOT=$(git rev-parse --show-toplevel)
SANDBOX=$(mktemp -d 2>/dev/null || mktemp -d -t specreview)

# --- що рецензентові дозволено бачити ---------------------------------------
# Специфікацію під рев'ю, тікет-джерело і незмінний контракт типів. Більш нічого.
mkdir -p "$SANDBOX/docs/spec" "$SANDBOX/materials" "$SANDBOX/app/src" "$SANDBOX/.claude/agents"
cp "$REPO_ROOT/docs/spec/pricing-discounts.md" "$SANDBOX/docs/spec/"
cp "$REPO_ROOT/materials/feature-request.md"   "$SANDBOX/materials/"
cp "$REPO_ROOT/app/src/types.ts"               "$SANDBOX/app/src/"
cp "$REPO_ROOT/app/src/pricing.ts"             "$SANDBOX/app/src/"
cp "$REPO_ROOT/docs/agents/spec-ambiguity-reviewer.md" "$SANDBOX/.claude/agents/"

# --- другий шар: заборона шляхів навіть за абсолютним посиланням --------------
# У пісочниці цих файлів і так немає; це зупиняє читання, яке тягнеться назад у
# вихідний репозиторій. Заборони на шелл-команди — оборона в глибину, а не
# гарантія: `Bash` лишається інструментом загального призначення (напр. `node`
# читає файли сам), і саме тому головний захист — відсутність файлів у дереві.
cat > "$SANDBOX/.claude/settings.json" <<'JSON'
{
  "permissions": {
    "deny": [
      "Read(**/discounts.ts)",
      "Read(**/discounts.test.ts)",
      "Read(**/traceability.md)",
      "Read(**/ab-validation.md)",
      "Read(**/sdd-tool.md)",
      "Read(**/task-e-bonus.md)",
      "Read(**/openspec/**)",
      "Bash(cat:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(sed:*)",
      "Bash(less:*)",
      "Bash(more:*)"
    ]
  }
}
JSON

# --- довести або впасти ------------------------------------------------------
FORBIDDEN="discounts.ts discounts.test.ts traceability.md ab-validation.md sdd-tool.md task-e-bonus.md"
leaked=""
for name in $FORBIDDEN; do
  if [ -n "$(find "$SANDBOX" -name "$name" -print -quit)" ]; then
    leaked="$leaked $name"
  fi
done
if [ -n "$(find "$SANDBOX" -type d -name openspec -print -quit)" ]; then
  leaked="$leaked openspec/"
fi

if [ -n "$leaked" ]; then
  echo "ПОМИЛКА: реалізація протекла в пісочницю:$leaked" >&2
  rm -rf "$SANDBOX"
  exit 1
fi

echo "Пісочниця: $SANDBOX"
echo "Видно рецензентові:"
find "$SANDBOX" -type f -not -path '*/.claude/*' | sed "s|$SANDBOX|  .|"
echo "Ізоляцію перевірено: у дереві немає ні реалізації, ні тестів, ні простежуваності, ні openspec/."

PROMPT="Дій як spec-ambiguity-reviewer, описаний у .claude/agents/spec-ambiguity-reviewer.md. Прорецензуй docs/spec/pricing-discounts.md проти materials/feature-request.md, використовуючи app/src/types.ts і app/src/pricing.ts як незмінний контракт. Звітуй українською."

if [ "${1:-}" = "--run" ]; then
  # Прибираємо за собою лише коли самі ж і запустили рев'ю: інакше каталог
  # потрібен користувачеві, щоб виконати надруковану нижче команду.
  trap 'rm -rf "$SANDBOX"' EXIT INT TERM
  cd "$SANDBOX"
  claude --permission-mode acceptEdits -p "$PROMPT"
else
  echo
  echo "Щоб запустити рев'ю:"
  echo "  cd \"$SANDBOX\" && claude --permission-mode acceptEdits -p \"$PROMPT\""
  echo "Після завершення приберіть каталог: rm -rf \"$SANDBOX\""
fi
