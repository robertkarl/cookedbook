.PHONY: build serve clean

build:
	hugo --minify

serve:
	hugo server --buildDrafts --navigateToChanged

clean:
	rm -rf public/
