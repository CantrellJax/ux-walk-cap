import json
import os
import sys
from pathlib import Path

PREFIX = "https://github.com/"


def repository_name(repo_url):
	if not repo_url.startswith(PREFIX):
		raise SystemExit(f"brand.json repo_url must start with {PREFIX}")
	name = repo_url[len(PREFIX) :]
	owner, separator, repo = name.partition("/")
	if not owner or not separator or not repo or "/" in repo:
		raise SystemExit(f"brand.json repo_url must be {PREFIX}<owner>/<repo>")
	return name


def main():
	root = Path(__file__).resolve().parent.parent
	brand = json.loads((root / "crates/fork-brand/brand.json").read_text())
	ok = (
		"true"
		if os.environ.get("GITHUB_REPOSITORY") == repository_name(brand["repo_url"])
		else "false"
	)
	output = os.environ.get("GITHUB_OUTPUT")
	if not output:
		print(ok)
		return 0 if ok == "true" else 1
	with open(output, "a") as handle:
		handle.write(f"ok={ok}\n")
	return 0


if __name__ == "__main__":
	sys.exit(main())
