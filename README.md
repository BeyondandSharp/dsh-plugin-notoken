# dsh-plugin-notoken

DSH 本地插件：注册一个登录入口路由（默认 `GET /__dsh_login`），把进程里的登录 token 换成浏览器会话
cookie，让首次访问不用带 `?token=…`。

## ⚠️ 不安全

装上之后，**任何能访问这个端口、并且 Host 通过 DSH 信任围栏的人，都等于拿到了 operator 权限** ——
可以执行工具、读取凭据、以运行 `dsh web` 的 OS 用户身份操作这台机器。

## 原理

DSH 只在两处做浏览器认证：`frontend-static` 渲染 index 前调用 `connection.authorizeIndex()`，以及
`/api` 路由自己的准入检查。**插件注册的具名路由在两者之前匹配、默认不认证** —— 入口就在这条缝里：

```
GET /__dsh_login
  ├─ connection.requestRejection()  先过信任围栏：403 拒绝；401（还没有会话）放行
  ├─ connection.authenticatedUrl()  取当前进程 token（每次请求都取，重启后仍有效）
  ├─ connection.authorizeIndex()    进程内完成 token → cookie 交换（303 + Set-Cookie）
  └─ 普通导航：把 303 转发给浏览器
     跨站导航（点链接、主屏幕图标启动）：直接返回应用外壳，cookie 一起下发
     （那条链上 SameSite=Strict 的 cookie 会被一直扣住，走 303 会变成"重定向次数过多"）
```

不签 cookie、不接触密钥、不解析启动输出、不改 DSH 源码。

## 安装

```sh
$DSH plugin --profile web add @beyondandsharp/dsh-plugin-notoken         # 从 npm
# 也可以直接装 GitHub 或本地目录：
$DSH plugin --profile web add github:BeyondandSharp/dsh-plugin-notoken
$DSH plugin --profile web add /path/to/dsh-plugin-notoken                # DSH=/path/to/dsh
```

## nginx

示例见 [examples/nginx.conf](examples/nginx.conf)：把裸 `/` 的 401 在服务端内部改写成入口，
地址栏全程停在 `/`。两条硬规则：`Host` 原样透传（cookie 绑定它），且该 authority 在 `trustedHosts` 里；
只拦 `location = /`，`/api` 与 WebSocket 一律原样透传。

## 验证

```sh
node --test && bash verify/e2e.sh
```
