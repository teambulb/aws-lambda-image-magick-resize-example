# syntax=docker/dockerfile:1
FROM public.ecr.aws/lambda/nodejs:22

############################
# 1) Install build deps   #
############################
RUN dnf install -y \
    git \
    gcc gcc-c++ make cmake pkgconfig \
    automake autoconf \
    libtool libtool-ltdl-devel \
    libjpeg-turbo-devel \
    libpng-devel \
    libwebp-devel \
    openjpeg2-devel \
    libtiff-devel \
    lcms2-devel \
    libxml2-devel \
    zlib-devel \
    xz xz-libs \
    bzip2 bzip2-libs \
    && dnf clean all

############################
# 2) Build ImageMagick & its libs
############################
ENV PKG_CONFIG_PATH=/usr/local/lib64/pkgconfig:/usr/local/lib/pkgconfig
ENV CFLAGS="-I/usr/local/include"
ENV LDFLAGS="-L/usr/local/lib64 -L/usr/local/lib"
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/local/lib64:${LD_LIBRARY_PATH:-}
ENV MAGICK_CODER_MODULE_PATH=/usr/local/lib/ImageMagick-7.1.1/modules-Q16/coders

COPY build/build_imagemagick.sh /root/build/build_imagemagick.sh
RUN chmod +x /root/build/build_imagemagick.sh \
    && /root/build/build_imagemagick.sh

############################
# 3) Copy only runtime .so’s & magick binary
############################
RUN find /usr/local/lib /usr/local/lib64 -type f -name "lib*.so*" \
    -exec cp -v {} /lib64/ \; \
    && mkdir -p /opt/bin \
    && cp /usr/local/bin/magick /opt/bin/magick

############################
# 4) Sanity check         #
############################
RUN echo "Linked libs:" \
    && ldd /opt/bin/magick \
    && echo "Formats:" \
    && /opt/bin/magick identify -list format

############################
# 5) Copy Lambda code     #
############################
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN cd ${LAMBDA_TASK_ROOT} && npm ci
COPY function.js ${LAMBDA_TASK_ROOT}/

CMD [ "function.handler" ]
