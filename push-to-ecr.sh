# Make sure the dockerfile is built first!

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 720974690363.dkr.ecr.us-east-1.amazonaws.com

docker tag image-resizer:1.0.11 720974690363.dkr.ecr.us-east-1.amazonaws.com/image-resizing:1.0.11

docker push 720974690363.dkr.ecr.us-east-1.amazonaws.com/image-resizing:1.0.11

#aws lambda update-function-code \
#  --function-name staging-image-upload-docker \
#  --image-uri 720974690363.dkr.ecr.us-east-1.amazonaws.com/image-resizing:1.0.5 \
#  --region us-east-1 \
#  --no-cli-pager

echo "✅ Lambda 'staging-image-upload-docker' successfully updated with the latest image."
