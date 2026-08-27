# Stirling with the tesseract languages a document archive actually meets (docs/05 §5.5).
#
# The upstream image carries `chi_sim deu eng fra osd por` and nothing else. Legere's default
# OCR_LANGUAGES is `rus+eng`, and a document already known to be Russian is sent as `rus` alone —
# which that image answers with "Invalid OCR languages format: none of the selected languages are
# valid" and no text at all. Docling was given its languages for the same reason (ADR-018); this is
# the same list, so an instance reads the same documents whichever parser it runs.
#
# 🔒 Pinned by digest, not by a tag (SEC-79): this is the base of one of the two containers that
# open whatever a scan finds, and `:latest` is whatever its owner last pushed. The tag beside the
# digest is what a person reads and what Dependabot rewrites together with it. Moving it by hand:
#
#   docker buildx imagetools inspect stirlingtools/stirling-pdf:latest --format '{{.Manifest.Digest}}'
FROM stirlingtools/stirling-pdf:2.14.3@sha256:3b3670fce70b396ec56ba380a3cc7858e0abf83fe13f31c88f7737847763a396

# tessdata_fast: a few MB per language, and the accuracy difference against the full models is not
# visible on document scans. 🔒 A commit, not `main`: the language data is parsed by tesseract's
# native code inside the container that OCRs every document, so what it is depends on nothing that
# can move under a rebuild. Newer data is a deliberate edit of this line.
ARG TESSDATA_REF=87416418657359cb625c412a48b6e1d6d41c29bd
ARG LANGUAGES="rus ukr srp srp_latn deu fra spa ita pol tur"

# TESS_BASE_PATH is where this image's tesseract already looks; the default is what it holds today,
# for the day the variable stops being set.
RUN set -eu; \
    tessdata="${TESS_BASE_PATH:-/usr/share/tesseract-ocr/5/tessdata}"; \
    for lang in ${LANGUAGES}; do \
      curl -fsSL -o "${tessdata}/${lang}.traineddata" \
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REF}/${lang}.traineddata"; \
    done; \
    chmod 0644 "${tessdata}"/*.traineddata; \
    tesseract --list-langs

# 🔒 SEC-78. The deployment runs this container as uid 1001 with a read-only root filesystem
# (docs/12 §12.7), and the upstream entrypoint stands in the way of both: before it starts anything
# it links its diagnostics helper into `/usr/local/bin`, which a non-root process may not write and
# a read-only filesystem does not let anyone write — and `set -e` turns that into a container that
# exits 1 without a line about why. Taking the executable bit off the helper is what the entrypoint
# tests for (`if [ -x … ]`), so the whole block is skipped; the script is still there and still runs
# as `docker exec … bash /scripts/stirling-diagnostics.sh`. Everything else Stirling writes is a
# path the deployment mounts (§12.7).
RUN chmod -x /scripts/stirling-diagnostics.sh

# 🔒 The image's own default is root, and nothing this process does needs it — it decodes whatever a
# scan finds, through tesseract, Ghostscript, LibreOffice and PDFBox. `stirlingpdfuser` (1001) is the
# account the upstream entrypoint drops to when it is started as root, and the one that already owns
# every directory Stirling writes; starting as it directly means no step of this container ever runs
# as root, with or without the `user:` the compose file also sets.
USER stirlingpdfuser
