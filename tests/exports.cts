import SDK = require("@nodana/phoenixd-l402-sdk");
import Core = require("@nodana/phoenixd-ts");

const node = new Core.Phoenixd("https://node.example.test", "password");
SDK.L402.create({
  client: node,
  secretKey: "a".repeat(64),
}).charge({
  amount: "100",
});
