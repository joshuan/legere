# Docling with the languages a document archive actually meets (docs/05 §5.5).
#
# The upstream image ships tesseract with `eng` and `osd` only, and its default OCR engine
# (RapidOCR) has no Cyrillic model at all — asked for Russian it silently falls back to the Chinese
# model set and returns mangled text with a confident-looking score. So: real tesseract language
# data, and Legere asks for the tesseract engine by name.
#
# 🔒 Pinned by digest, not by a tag (SEC-79): this is the base of one of the two containers that
# open whatever a scan finds, and `:latest` is whatever its owner last pushed. The tag beside the
# digest is what a person reads and what Dependabot rewrites together with it. Moving it by hand:
#
#   docker buildx imagetools inspect quay.io/docling-project/docling-serve-cpu:latest \
#     --format '{{.Manifest.Digest}}'
FROM quay.io/docling-project/docling-serve-cpu:v1.31.0@sha256:32ba1a1dded8d8fd21f9d8da1b9837e04cfee164ef891d9513174c3d989dcee9

# tessdata_fast: a few MB per language, and the accuracy difference against the full models is not
# visible on document scans. 🔒 A commit, not `main`: the language data is parsed by tesseract's
# native code inside the container that OCRs every document, so what it is depends on nothing that
# can move under a rebuild. Newer data is a deliberate edit of this line.
ARG TESSDATA_REF=87416418657359cb625c412a48b6e1d6d41c29bd
ARG LANGUAGES="rus ukr srp srp_latn deu fra spa ita pol tur"

USER 0
RUN set -eu; \
    for lang in ${LANGUAGES}; do \
      curl -fsSL -o "/usr/share/tesseract/tessdata/${lang}.traineddata" \
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_REF}/${lang}.traineddata"; \
    done; \
    chmod 0644 /usr/share/tesseract/tessdata/*.traineddata; \
    tesseract --list-langs

# Captions for the pictures inside documents (DOCLING_PICTURE_DESCRIPTION). Empty by default and
# deliberately so: the weights are 513 MB, and on CPU one page with three small pictures took 17
# minutes — read docs/12 §12.4 before turning it on. To include the model:
#   --build-arg PICTURE_DESCRIPTION_MODEL=HuggingFaceTB/SmolVLM-256M-Instruct
# Docling looks for it under ~/.cache/docling/models as "<owner>--<repo>", which is the layout the
# download below writes. The onnx variants in these repos are another 2.8 GB and Docling loads the
# safetensors, so they are skipped.
ARG PICTURE_DESCRIPTION_MODEL=""
RUN set -eu; \
    if [ -n "${PICTURE_DESCRIPTION_MODEL}" ]; then \
      owner="${PICTURE_DESCRIPTION_MODEL%%/*}"; \
      repo="${PICTURE_DESCRIPTION_MODEL#*/}"; \
      python3 -c "import sys; from huggingface_hub import snapshot_download; \
snapshot_download(sys.argv[1], local_dir=sys.argv[2], ignore_patterns=['onnx/*'])" \
        "${PICTURE_DESCRIPTION_MODEL}" "/opt/app-root/src/.cache/docling/models/${owner}--${repo}"; \
      chown -R 1001:0 /opt/app-root/src/.cache; \
    fi
USER 1001
