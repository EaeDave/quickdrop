import index from "./index.html";

Bun.serve({
  hostname: "127.0.0.1",
  port: 1420,
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log("QuickDrop desktop dev server running at http://127.0.0.1:1420");
