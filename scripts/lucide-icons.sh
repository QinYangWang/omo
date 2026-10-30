#!/usr/bin/env sh
# Refreshes internal/kit/icons/*.svg from lucide.dev, so the app ships the real
# Lucide set (ISC, see internal/kit/icons/LICENSE) instead of hand-copied paths.
#
# The names come from internal/kit/icons.go: to add an icon, add
# `IconFoo = mustIcon("foo")` there and run this script from anywhere.
#
#   ./scripts/lucide-icons.sh
#
# The source is Lucide's repository, which is what lucide.dev/icons serves; set
# LUCIDE_BASE to pin a tag, e.g.
#   LUCIDE_BASE=https://raw.githubusercontent.com/lucide-icons/lucide/0.545.0/icons ./scripts/lucide-icons.sh
set -eu

base=${LUCIDE_BASE:-https://raw.githubusercontent.com/lucide-icons/lucide/main/icons}
root=$(dirname "$0")/..
dir=$root/internal/kit/icons

if ! command -v curl >/dev/null 2>&1; then
	echo "lucide-icons: curl is required" >&2
	exit 1
fi

mkdir -p "$dir"
names=$(sed -n 's/.*mustIcon("\([a-z0-9-]*\)").*/\1/p' "$root/internal/kit/icons.go" | sort -u)
if [ -z "$names" ]; then
	echo "lucide-icons: no mustIcon names in internal/kit/icons.go" >&2
	exit 1
fi

# Drop icons that icons.go no longer names.
for file in "$dir"/*.svg; do
	[ -e "$file" ] || continue
	name=$(basename "$file" .svg)
	if ! printf '%s\n' "$names" | grep -qx "$name"; then
		echo "drop $name"
		rm "$file"
	fi
done

for name in $names; do
	if curl -fsS --retry 2 -m 30 -o "$dir/$name.svg" "$base/$name.svg"; then
		echo "ok   $name"
	else
		echo "FAIL $name: lucide has no icon by that name" >&2
		exit 1
	fi
done

curl -fsS --retry 2 -m 30 -o "$dir/LICENSE" "$base/../LICENSE" && echo "ok   LICENSE"
