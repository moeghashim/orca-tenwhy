import { resolve } from "node:path";

export default {
  build: {
    rollupOptions: {
      input: {
        main: resolve("index.html"),
        contact: resolve("contact.html"),
        whitening: resolve("whitening.html"),
        aligners: resolve("aligners.html"),
        checkup: resolve("checkup.html"),
      },
    },
  },
};
