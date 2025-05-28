# syntax=docker/dockerfile:1

# Base image for AWS Lambda with Node.js 22
FROM public.ecr.aws/lambda/nodejs:22 AS builder

# Update packages and install build dependencies
RUN dnf update -y && \
        dnf install -y gcc-c++ make cmake pkg-config git tar gzip \
        libjpeg-turbo-devel libpng-devel libtiff-devel giflib-devel libwebp-devel && \
        dnf clean all

# Install libde265 and x265 dependencies for HEIC support

RUN git clone https://github.com/videolan/x265.git && \
    cd x265/build/linux && \
    cmake -G "Unix Makefiles" -DCMAKE_INSTALL_PREFIX=/usr/local ../../source && \
    make -j$(nproc) && \
    make install && \
    cd ../../.. && \
    rm -rf x265 && \
    dnf clean all

# Build libde265 from source (required for HEIC decoding)
RUN curl -L https://github.com/strukturag/libde265/releases/download/v1.0.15/libde265-1.0.15.tar.gz -o libde265.tar.gz && \
    tar -xzf libde265.tar.gz && \
    cd libde265-1.0.15 && \
    ./configure --prefix=/usr/local --disable-sherlock265 --disable-dec265 && \
    make -j$(nproc) && \
    make install && \
    cd .. && \
    rm -rf libde265* && \
    dnf clean all

# Install libheif from source for HEIC/HEIF support
RUN curl -L https://github.com/strukturag/libheif/releases/download/v1.17.6/libheif-1.17.6.tar.gz -o libheif.tar.gz && \
    tar -xzf libheif.tar.gz && \
    cd libheif-1.17.6 && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release \
          -DWITH_EXAMPLES=OFF \
          -DWITH_DAV1D=OFF \
          -DWITH_AOM=OFF \
          -DWITH_RAV1E=OFF \
          -DWITH_SvtEnc=OFF \
          -DWITH_KVAZAAR=OFF \
          -DWITH_OpenJPEG=OFF \
          -DWITH_FFMPEG=OFF \
          -DWITH_LIBSHARPYUV=OFF \
          .. && \
    make -j$(nproc) && \
    make install && \
    cd ../.. && \
    rm -rf libheif* && \
    dnf clean all

# Set the working directory
WORKDIR /var/task

# Copy package files
COPY package.json package-lock.json ./

# Install Node.js dependencies
RUN npm ci --omit=dev

# Rebuild Sharp for Lambda environment with HEIC support
RUN npm rebuild sharp --platform=linux --arch=x64

# Copy the source code
COPY src/ ./src/


#############################
# Stage 2: Runtime only     #
#############################
FROM public.ecr.aws/lambda/nodejs:22

# Create working dir
WORKDIR /var/task

# Copy node_modules and app code from builder
COPY --from=builder /var/task /var/task

# Copy only necessary shared libraries
COPY --from=builder /usr/local /usr/local

# Reduce size - remove headers, docs, dev artifacts
RUN rm -rf /usr/local/include /usr/local/share /usr/local/lib/pkgconfig \
           /usr/local/lib/cmake /usr/local/lib/*.a && \
    strip --strip-unneeded /usr/local/lib/*.so* || true

# Set library path
ENV LD_LIBRARY_PATH=/usr/local/lib64:/usr/local/lib:/usr/lib64

# Test if Sharp is properly installed with HEIC support
RUN node -e "try { \
    const sharp = require('sharp'); \
    console.log('✅ Sharp installed successfully'); \
    console.log('Sharp version:', sharp.versions); \
    console.log('Supported formats:'); \
    Object.entries(sharp.format).forEach(([format, details]) => { \
        if (details.input && details.input.buffer) { \
            console.log('  Input:', format); \
        } \
    }); \
} catch(e) { \
    console.error('❌ Sharp installation failed:', e.message); \
    process.exit(1); \
}"

# Set environment variables for optimal performance
ENV NODE_ENV=production \
    UV_THREADPOOL_SIZE=64

# Lambda entry point
CMD ["src/handler.handler"]
