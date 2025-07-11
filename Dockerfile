# syntax=docker/dockerfile:1

###############################
# Stage 1: Build environment  #
###############################
FROM public.ecr.aws/lambda/nodejs:22-arm64 AS builder

ENV PREFIX_PATH=/usr/local \
    LIB_PATH=/usr/local/lib \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib64/pkgconfig \
    LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64

WORKDIR /build

# Install build dependencies
RUN dnf install -y \
    xz \
    git \
    glibc \
    glib2-devel \
    expat-devel \
    libjpeg-turbo-devel \
    libpng-devel \
    giflib-devel \
    libexif-devel \
    librsvg2-devel \
    libtiff-devel \
    lcms2-devel \
    gobject-introspection-devel \
    libxml2-devel \
    cairo-devel \
    pango-devel \
    gcc-c++ \
    make \
    gettext \
    automake \
    autoconf \
    libtool \
    python3 \
    cmake \
    meson \
    ninja-build \
    pkgconfig && \
    dnf clean all && \
    rm -rf /var/cache/dnf

# Install libwebp
RUN curl -L https://github.com/webmproject/libwebp/archive/v1.4.0.tar.gz | tar zx && \
    cd libwebp-1.4.0 && \
    ./autogen.sh && \
    ./configure --enable-libwebpmux --prefix=${PREFIX_PATH} && \
    make -j$(nproc) && make install

ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib64/pkgconfig
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64:$LD_LIBRARY_PATH

# Build x265 with shared library
RUN git clone https://github.com/videolan/x265.git && \
    cd x265/build/linux && \
    cmake -G "Unix Makefiles" -DCMAKE_INSTALL_PREFIX=/usr/local ../../source && \
    make -j$(nproc) && \
    make install && \
    cd ../../.. && \
    rm -rf x265 && \
    dnf clean all

# ✅ Verify that .so file is present
    RUN ls -l /usr/local/lib | grep libx265 && \
    if [ ! -f /usr/local/lib/libx265.so ]; then echo "❌ libx265.so not found. Build failed." && exit 1; fi

ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib64/pkgconfig
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64:$LD_LIBRARY_PATH

# Build libde265
RUN curl -LO https://github.com/strukturag/libde265/releases/download/v1.0.15/libde265-1.0.15.tar.gz && \
    tar -xzf libde265-1.0.15.tar.gz && \
    cd libde265-1.0.15 && \
    ./configure --prefix=${PREFIX_PATH} && \
    make -j$(nproc) && make install

ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib64/pkgconfig
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64:$LD_LIBRARY_PATH

# Build libheif with x265 and libde265
RUN curl -L https://github.com/strukturag/libheif/releases/download/v1.18.2/libheif-1.18.2.tar.gz | tar zx && \
    cd libheif-1.18.2 && mkdir build && cd build && \
    cmake -DCMAKE_INSTALL_PREFIX=${PREFIX_PATH} \
          -DBUILD_SHARED_LIBS=ON \
          -DWITH_X265=ON \
          -DWITH_DE265=ON \
          -DWITH_AOM_DECODER=OFF \
          -DWITH_EXAMPLES=ON \
          .. && \
    make -j$(nproc) && make install && \
    cp ../bin/heif-* /usr/bin/ || echo "heif tools not found"

ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib64/pkgconfig
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64:$LD_LIBRARY_PATH

RUN /sbin/ldconfig || /usr/sbin/ldconfig || echo "ldconfig not available"

# Build libvips with HEIC support
# Build libvips from source with HEIF, WebP, TIFF, PNG etc.
RUN curl -L https://github.com/libvips/libvips/releases/download/v8.16.1/vips-8.16.1.tar.xz | tar xJ && \
    cd vips-8.16.1 && \
    meson setup build \
      --prefix=${PREFIX_PATH} \
      --libdir=${LIB_PATH} \
      -Dheif=enabled \
      -Dlibheif=enabled \
      -Dde265=enabled \
      -Dlcms=enabled \
      -Dpng=enabled \
      -Dtiff=enabled \
      -Dwebp=enabled \
      --buildtype release && \
    cd build && \
    meson compile || (cat meson-logs/meson-log.txt || echo "⚠️ No meson compile log found" && exit 1) && \
    meson install && \
    echo "✅ libvips 8.16.1 built successfully"

    # Setup output directories
WORKDIR /layer
RUN mkdir -p /layer/nodejs /layer/lib

# Install node-gyp and node-addon-api
RUN npm install --prefix /layer/nodejs node-gyp node-addon-api

RUN pkg-config --cflags glib-2.0 && pkg-config --libs glib-2.0

# Copy package files
COPY package.json package-lock.json ./

# Install Node.js dependencies
RUN npm ci --omit=dev

# Install sharp from source
RUN PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib64/pkgconfig \
    LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64 \
    CFLAGS="$(pkg-config --cflags glib-2.0)" \
    CPPFLAGS="$(pkg-config --cflags glib-2.0)" \
    LDFLAGS="$(pkg-config --libs glib-2.0)" \
    npm install --prefix /layer/nodejs sharp@0.34.2 \
        --build-from-source \
        --platform=linux \
        --arch=arm64
# Extract native dependencies from sharp binary
RUN SHARP_BIN=$(find /layer/nodejs/node_modules/sharp -type f -name '*.node' | grep -E 'Release/.*\.node$' | head -n 1) && \
    echo "🔍 Found SHARP_BIN=$SHARP_BIN" && \
    ldd "$SHARP_BIN" | awk '{print $3}' | grep '^/' | xargs -I '{}' cp -v '{}' /layer/lib

# Confirm versions
RUN node -e "console.log('✅ Sharp version:', require('/layer/nodejs/node_modules/sharp').versions)"

###################################
# Stage 2: Runtime test & verify  #
###################################
FROM public.ecr.aws/lambda/nodejs:22-arm64

# Copy sharp layer and native dependencies
COPY --from=builder /layer/nodejs /opt/nodejs
COPY --from=builder /layer/lib /opt/lib
COPY --from=builder /usr/local/bin/vips /usr/local/bin/
COPY --from=builder /usr/local/bin/heif-convert /usr/local/bin/
COPY --from=builder /usr/local/lib /usr/local/lib
COPY --from=builder /usr/local/lib64 /usr/local/lib64
COPY --from=builder layer/node_modules ./node_modules

# Set persistent environment variables
ENV NODE_PATH=/opt/nodejs/node_modules
ENV LD_LIBRARY_PATH="/usr/local/lib:/usr/local/lib64:/opt/lib:/var/lang/lib:/lib64:/usr/lib64:/var/runtime:/var/runtime/lib:/var/task:/var/task/lib:$LD_LIBRARY_PATH"

WORKDIR /var/task

COPY src/ ./src/

# Add test file
COPY sharp-test.js ./
COPY sample.heic ./

# ✅ Test libheif CLI if present
RUN if command -v heif-convert >/dev/null; then \
      echo "🧪 Testing libheif: converting HEIC to PNG" && \
      heif-convert sample.heic output-libheif.png && \
      echo "✅ libheif decode successful"; \
    else \
      echo "⚠️ heif-convert not available"; \
    fi

# ✅ Test libvips CLI if present
RUN if command -v vips >/dev/null; then \
      echo "🧪 Testing libvips: converting HEIC to PNG" && \
      vips copy sample.heic output-libvips.png && \
      echo "✅ libvips decode successful"; \
    else \
      echo "⚠️ vips not found"; \
    fi

# ✅ Test Sharp Node.js binding
RUN echo "🧪 Testing sharp HEIC decode via JS" && \
    node sharp-test.js

# Set environment variables for optimal performance
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=64

# Lambda entry point
CMD ["src/handler.handler"]
