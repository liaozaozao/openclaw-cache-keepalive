/** Status page HTML renderer — assembles template + style + client into a single HTML page. */
"use strict";

const { STATUS_PAGE_STYLE } = require("./style");
const { STATUS_PAGE_TEMPLATE } = require("./template");
const { STATUS_PAGE_CLIENT } = require("./client");

function renderStatusPage() {
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "  <title>缓存保活状态</title>",
    "  <style>",
    STATUS_PAGE_STYLE,
    "  </style>",
    "</head>",
    "<body>",
    STATUS_PAGE_TEMPLATE,
    "  <script>",
    STATUS_PAGE_CLIENT,
    "  </script>",
    "</body>",
    "</html>"
  ].join("\n");
}

module.exports = {
  renderStatusPage,
};
