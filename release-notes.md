# 本次改动

- 修「只更新了网页却仍提示更新应用」：版本号文件 android/version.properties 每次发版都会变，
  之前被算作原生改动，导致 apkRequired 恒为 true
