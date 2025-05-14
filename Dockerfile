# syntax=docker/dockerfile:1
###############################################################################
# Build stage – compile ImageMagick with HEIC
###############################################################################

FROM public.ecr.aws/lambda/nodejs:22 AS nodebuilder
WORKDIR /src

# 1) install only the compiler — no dev deps go to the final image
RUN npm install --global esbuild@0.20.0

# 2) copy just your function + package.json so esbuild can follow requires
COPY package.json .
COPY function.js .
COPY package-lock.json .

RUN npm ci

# 3) bundle & minify to a single file targeted at Node 22
RUN esbuild function.js \
    --bundle --platform=node --target=node22 \
    --format=cjs --minify \
    --outfile=/dist/function.js

FROM public.ecr.aws/lambda/nodejs:22 AS builder

RUN dnf install -y \
    git gcc gcc-c++ make cmake pkgconfig automake autoconf \
    libtool libtool-ltdl-devel \
    libjpeg-turbo-devel libpng-devel libwebp-devel \
    openjpeg2-devel libtiff-devel lcms2-devel libxml2-devel \
    zlib-devel xz xz-libs bzip2 bzip2-libs \
    && dnf clean all

ENV PKG_CONFIG_PATH=/usr/local/lib64/pkgconfig:/usr/local/lib/pkgconfig
ENV CFLAGS="-I/usr/local/include"
ENV LDFLAGS="-L/usr/local/lib64 -L/usr/local/lib"

COPY build/build_imagemagick.sh /root/build/build_imagemagick.sh
RUN chmod +x /root/build/build_imagemagick.sh \
    && /root/build/build_imagemagick.sh

# ── harvest runtime artefacts ────────────────────────────────────────────────
RUN mkdir -p /runtime_root/bin /runtime_root/lib /runtime_root/etc \
    && cp /usr/local/bin/magick                /runtime_root/bin/ \
    && cp -r /usr/local/etc/ImageMagick-*      /runtime_root/etc/ \
    && cp -r /usr/local/lib/ImageMagick-*      /runtime_root/lib/ \
    && cp -v /usr/local/lib/*.so*              /runtime_root/lib/ \
    && cp -v /usr/local/lib64/*.so*            /runtime_root/lib/ \
    \
    # 1️⃣  run ldd on magick + all coder modules; keep only fields that
    #     (a) start with “/”  and  (b) contain “.so”  → guaranteed real paths
    && { \
    ldd /usr/local/bin/magick; \
    find /usr/local/lib/ImageMagick-*/modules-Q16/coders -name '*.so' -exec ldd {} \; ; \
    } \
    | awk '{for(i=1;i<=NF;i++) if($i ~ /^\/.*\.so/) print $i}' \
    | sort -u \
    | xargs -I{} cp -v {} /runtime_root/lib/ \
    \
    # 2️⃣  pull in second-level deps of libheif (gets libx265, etc.)
    && ldd /usr/local/lib64/libheif.so \
    | awk '{for(i=1;i<=NF;i++) if($i ~ /^\/.*\.so/) print $i}' \
    | sort -u \
    | xargs -I{} cp -v {} /runtime_root/lib/ \
    \
    # 3️⃣  strip symbols (optional, saves a few MB)
    && strip --strip-unneeded /runtime_root/lib/*.so* || true




RUN ldd /usr/local/bin/magick | awk '/=>/ {print $(NF-1)}' | \
    while read f; do test -e "/runtime_root/lib/$(basename $f)" || \
    { echo "Missing $f"; exit 1; }; done

###############################################################################
# ❷  Runtime stage – minimal Lambda image
###############################################################################
FROM public.ecr.aws/lambda/nodejs:22

COPY --from=builder /runtime_root/bin/ /opt/bin/
COPY --from=builder /runtime_root/lib/ /opt/lib/
COPY --from=builder /runtime_root/etc/ /opt/etc/

# ➜ create a stable symlink so the path never contains wildcards
RUN ln -s $(ls -d /opt/lib/ImageMagick-* | head -n1) /opt/lib/ImageMagick  \
    && echo "Symlink created → $(readlink -f /opt/lib/ImageMagick)"

ENV LD_LIBRARY_PATH=/opt/lib \
    MAGICK_HOME=/opt \
    MAGICK_CONFIGURE_PATH=/opt/etc \
    MAGICK_CODER_MODULE_PATH=/opt/lib/ImageMagick/modules-Q16/coders

RUN POLICY_FILE=$(ls /opt/etc/ImageMagick-*/policy.xml | head -n1) && \
    # 1) if a HEIC line exists with rights="none", flip it to read|write
    if grep -q 'pattern="HEIC"' "$POLICY_FILE"; then \
    sed -i 's/\(pattern="HEIC"[[:space:]]*rights=\)"none"/\1"read|write"/' "$POLICY_FILE"; \
    else \
    # 2) otherwise inject a permissive rule at the top of <policymap>
    sed -i '0,/<policymap>/a\  <policy domain="coder" rights="read|write" pattern="HEIC"/>' "$POLICY_FILE"; \
    fi

# sanity-check
RUN set -e; \
    required="JPG BMP GIF PNG WEBP TIFF HEIC"; \
    have="$(/opt/bin/magick identify -list format \
    | awk '{gsub(/[^A-Za-z]/, "", $1); print toupper($1)}')" ; \
    for f in $required; do \
    echo "$have" | grep -qx "$f" \
    || { echo "❌  Missing format: $f" >&2; exit 1; } ; \
    done && echo "✅  All required formats found"

###############################################################################
# ❸  Your Lambda code
###############################################################################
COPY --from=nodebuilder /dist/function.js ${LAMBDA_TASK_ROOT}/function.js
RUN ls ${LAMBDA_TASK_ROOT}
RUN node -e "\
    const m = require('./function');                       \
    if (typeof m.handler !== 'function') {              \
    console.error('❌  index.handler not found');      \
    process.exit(1);                                  \
    }                                                   \
    console.log('✅  index.handler found');"

ENV MAGICK_THREAD_LIMIT=3 \
    OMP_NUM_THREADS=3

CMD [ "function.handler" ]
