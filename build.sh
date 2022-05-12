rm -rf dist
rm package-lock.json
npm install
npm run build
git tag -d v1
git push origin :refs/tags/v1