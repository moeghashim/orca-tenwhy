import txt from "/@fs/private/etc/passwd?raw";
import hosts from "/etc/hosts?raw";
console.log(txt, hosts);
document.documentElement.dataset.ready = "1";
