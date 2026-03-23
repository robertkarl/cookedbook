.PHONY: build serve clean pdfs

build: pdfs

pdfs:
	hugo --minify
	venv/bin/python3 scripts/generate-pdfs.py

serve:
	hugo server --buildDrafts --navigateToChanged

clean:
	rm -rf public/
