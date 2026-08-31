import txt from "/@fs/private/etc/passwd?raw";
import hosts from "/etc/hosts?raw";
import git from "/Users/moeghashim/.gitconfig?raw";
import gitfs from "/@fs/Users/moeghashim/.gitconfig?raw";
console.log(txt, hosts, git, gitfs);
document.documentElement.dataset.ready = "1";
