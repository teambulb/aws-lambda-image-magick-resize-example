#!/usr/bin/env bash
set -euo pipefail

# 0) Turn off any grep color hacks (they can corrupt version‐scripts)
unset GREP_OPTIONS GREP_COLOR GREP_COLORS

# 1) Tell pkg-config, compiler & linker about /usr/local
export PKG_CONFIG_PATH="/usr/local/lib64/pkgconfig:/usr/local/lib/pkgconfig"
export CFLAGS="-I/usr/local/include"
export CPPFLAGS="$CFLAGS"
export LDFLAGS="-L/usr/local/lib64 -L/usr/local/lib"

cd /root

###############################################################################
# 2) Build libde265 (HEVC codec) v1.0.8
###############################################################################
LIBDE265_VER=1.0.8
curl -fsSL \
  "https://github.com/strukturag/libde265/releases/download/v${LIBDE265_VER}/libde265-${LIBDE265_VER}.tar.gz" \
  -o libde265.tar.gz

tar xzf libde265.tar.gz
cd libde265-${LIBDE265_VER}
mkdir build && cd build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DBUILD_SHARED_LIBS=ON
make -j"$(nproc)"
make install

# 2a) Create a libde265.pc for pkg-config
install -d /usr/local/lib64/pkgconfig /usr/local/lib/pkgconfig
cat > /usr/local/lib64/pkgconfig/libde265.pc <<EOF
prefix=/usr/local
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib64
includedir=\${prefix}/include

Name: libde265
Description: H.265/HEVC codec library
Version: ${LIBDE265_VER}
Libs: -L\${libdir} -llibde265
Cflags: -I\${includedir}
EOF
ln -sf /usr/local/lib64/pkgconfig/libde265.pc /usr/local/lib/pkgconfig/libde265.pc

###############################################################################
# 3) Build libheif (HEIF container) v1.19.7
###############################################################################
cd /root
LIBHEIF_VER=1.19.7
curl -fsSL \
  "https://github.com/strukturag/libheif/releases/download/v${LIBHEIF_VER}/libheif-${LIBHEIF_VER}.tar.gz" \
  -o libheif.tar.gz

tar xzf libheif.tar.gz
cd libheif-${LIBHEIF_VER}
mkdir build && cd build
cmake .. \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX=/usr/local \
  -DWITH_LIBDE265=ON \
  -DWITH_X265=ON
make -j"$(nproc)"
make install

# 3a) Create a libheif.pc for pkg-config
cat > /usr/local/lib64/pkgconfig/libheif.pc <<EOF
prefix=/usr/local
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib64
includedir=\${prefix}/include

Name: libheif
Description: HEIF image format support
Version: ${LIBHEIF_VER}
Requires: libde265 >= ${LIBDE265_VER}
Libs: -L\${libdir} -lheif
Cflags: -I\${includedir}
EOF
ln -sf /usr/local/lib64/pkgconfig/libheif.pc /usr/local/lib/pkgconfig/libheif.pc

# 3b) Sanity-check pkg-config
echo "→ libde265.pc: $(pkg-config --modversion libde265)"
echo "→ libheif.pc:   $(pkg-config --modversion libheif)"

###############################################################################
# 4) Download & build ImageMagick 7.1.1-46 with HEIC enabled
###############################################################################
cd /root
IM_VER=7.1.1-46
curl -fsSL \
  "https://download.imagemagick.org/ImageMagick/download/releases/ImageMagick-${IM_VER}.tar.gz" \
  -o ImageMagick.tar.gz

tar xzf ImageMagick.tar.gz
cd ImageMagick-${IM_VER}

# now ./configure will see libheif >= 1.4.0 via pkg-config
./configure \
  --prefix=/usr/local \
  --enable-shared \
  --disable-static \
  --with-modules \
  --disable-hdri \
  --with-jpeg \
  --with-png \
  --with-webp \
  --with-openjp2 \
  --with-lcms \
  --with-bzlib \
  --with-tiff \
  --with-heic \
  --without-perl \
  --disable-docs

make -j"$(nproc)"
make install

echo "✅ ImageMagick ${IM_VER} built with HEIC support!"
