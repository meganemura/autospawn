# autospawn

[English](README.md)

標準入力と標準出力で通信するプログラム用の、既存プロセスへの接続または新規プロセスの起動を行うランチャーです。
クライアントは `autospawn connect` を起動します。
常駐プロセスがすでに動作している場合、connect はそのプロセスに接続します。
動作していない場合、connect は常駐プロセスを起動し、以降のすべてのクライアントがそれを共有します。

常駐プロセスは、シークレットリゾルバーなど、利用者が選んだコマンドを通じて一度だけ起動します。
その後、接続ごとにプログラムを新しい子プロセスとして起動します。
この子プロセスには、その一度の起動時に取得した環境から autospawn 自身の `AUTOSPAWN_*` 変数を除いたものが渡されます。
autospawn はバイト列を中継するだけで、その内容を読み取らないため、MCP サーバー、コマンドラインツール、長時間動作する監視プログラムなど、標準入出力を使うどのプログラムでも動作します。

## 使用例：1Password を使う MCP サーバー

一部の MCP サーバーには、API トークンなどのシークレットが必要です。
平文のトークンを設定ファイルに書かずに渡す一般的な方法は、サーバーの起動コマンドを `op run`（1Password CLI）でラップすることです。
このコマンドは起動時に `op://` 参照からトークンを読み取ります。

1Password の CLI 統合では、端末セッションごとにこのアクセスを承認します。
1Password 自身の文書によると、この承認は操作がない状態で10分後、遅くとも12時間後に期限切れになります。
MCP クライアントはサーバーを新しいプロセスとして起動し、1Password はそれを新しいセッションとして扱います。
サーバーを起動するたびに、Mac では Touch ID による承認を再度求められます。
複数のクライアント（Cursor、Claude Code、Codex）から同じサーバーを実行すると、承認回数はクライアント数に応じて増えます。

autospawn を使うと、`op run` は常駐プロセス用に一度だけ実行されます。
すべてのクライアントがその一つの常駐プロセスに接続するため、承認は最初の起動時に一度だけ行われます。

## インストール

```sh
npm install -g autospawn
```

autospawn には Node.js 24.10 以降が必要で、macOS と Linux で動作します。
Unix ドメインソケットを介して通信するため、Windows では動作しません。

## 例：1Password

以下の例では、すべてプレースホルダー名を使用しています。
`example`、`Private/example-api`、および各パスを利用者自身の値に置き換えてください。

### mcp.json（Cursor および同様のクライアント）

```json
{
  "mcpServers": {
    "example": {
      "command": "autospawn",
      "args": [
        "connect", "--name", "example", "--",
        "op", "run", "--",
        "autospawn", "serve", "--",
        "node", "/path/to/server.js"
      ],
      "env": {
        "PATH": "/path/to/bin:/usr/bin:/bin",
        "EXAMPLE_API_URL": "https://api.example.com",
        "EXAMPLE_CLIENT_ID": "op://Private/example-api/client-id",
        "EXAMPLE_CLIENT_SECRET": "op://Private/example-api/client-secret"
      }
    }
  }
}
```

Cursor などの GUI アプリは、シェルの `PATH` を読み取りません。
`op`、`node`、`autospawn` があるディレクトリを含むように `env.PATH` を設定してください。

### Claude Code

```sh
claude mcp add-json -s user example '{
  "command": "autospawn",
  "args": [
    "connect", "--name", "example", "--",
    "op", "run", "--",
    "autospawn", "serve", "--",
    "node", "/path/to/server.js"
  ],
  "env": {
    "EXAMPLE_API_URL": "https://api.example.com",
    "EXAMPLE_CLIENT_ID": "op://Private/example-api/client-id",
    "EXAMPLE_CLIENT_SECRET": "op://Private/example-api/client-secret"
  }
}'
```

このコマンドは、手作業で記述するものと同じ構造を `~/.claude.json` に書き込みます。

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.example]
command = "autospawn"
args = [
  "connect", "--name", "example", "--",
  "op", "run", "--",
  "autospawn", "serve", "--",
  "node", "/path/to/server.js",
]

[mcp_servers.example.env]
EXAMPLE_API_URL = "https://api.example.com"
EXAMPLE_CLIENT_ID = "op://Private/example-api/client-id"
EXAMPLE_CLIENT_SECRET = "op://Private/example-api/client-secret"
```

いずれの設定でも、最初に `example` を起動したクライアントが 1Password の承認を一度発生させます。
同じクライアントまたは別のクライアントによる以降の起動は常駐プロセスに接続し、承認を求めません。

1Password の項目、または動作中のサーバーが依存するその他のものを変更した場合、`autospawn stop --name example` を実行してください。
これにより、次の接続時に新しい値を使う常駐プロセスが起動します。

`--name` 自体を変更した場合は、古い名前の常駐プロセスも停止してください。
そのプロセスにはどこからも接続されなくなりますが、動作を続け、解決済みのシークレットを保持し続けます。

## 例：コマンドラインツール

MCP サーバーではないプログラムにも同じ構成を使えます。
この例では、エージェントがトークンを必要とするツールをタスクごとに一度実行し、1Password は初回だけ承認を求めます。

```sh
autospawn connect --name example-cli -- \
  op run -- \
  autospawn serve --idle-timeout 3600 -- \
  example-tool fetch
```

ツールの出力は、`example-tool fetch` を直接実行した場合と同様に標準出力へ送られ、`connect` はツールの終了コードで終了します。
`--idle-timeout` は、接続がない状態が1時間続くと常駐プロセスを終了します。

## コマンド

### `autospawn connect --name <name> [--timeout <seconds>] [--param <key>=<value>]... -- <command...>`

`<name>` という名前の常駐プロセスに接続し、まだ応答するプロセスがない場合は `<command...>` から起動します。
標準入力を常駐プロセスへ、常駐プロセスの出力を標準出力へバイト単位で中継し、すべての診断情報を標準エラー出力へ送ります。
`--timeout`（既定値は120秒）は、新しく起動した常駐プロセスが立ち上がるまで connect が待機する時間を制限します。
この時間は、利用者が 1Password のプロンプトを承認するのに十分な長さです。
`--param` は、この接続だけの値を送ります。
詳しくは、下の「接続ごとの値」を参照してください。

connect は、プログラムの終了コードで終了します。
シグナルで終了したプログラムの場合は 128 にシグナルの番号を足した値、起動できなかったプログラムの場合は 127 になり、シェルと同じです。
プログラムの終了状態が届く前に接続が切れた場合は 1 になります。
autospawn 0.1.0 が起動した常駐プロセスは終了状態を送らないので、その場合 connect は終了コード 0 で終了します。

### `autospawn serve [--idle-timeout <seconds>] [--param <key>=<ENV_NAME>]... -- <command...>`

常駐プロセスのソケットで待ち受け、受け付けた接続ごとに `<command...>` を新しい子プロセスとして起動します。
`connect` だけが `serve` を起動します。
`connect` が設定する環境変数が必要なため、直接実行すると失敗します。
`--idle-timeout` を指定すると、指定した秒数にわたって実行中の子プロセスも準備中の接続もない状態が続いた時点で serve が終了します。
指定しない場合、serve は停止されるまで動作します。
`--param` は、接続が送ってよいキーと、そのキーの値を接続の子プロセスに渡す環境変数を宣言します。

### `autospawn stop --name <name>`

`<name>` という名前の常駐プロセスに終了を要求します。
常駐プロセスを停止した場合または動作中のプロセスが見つからなかった場合は終了コード 0 で終了し、エラー時は終了コード 1 で終了します。

## 接続ごとの値

呼び出しごとに変わる値を、同じシークレットと一緒に必要とするプログラムがあります。
たとえば、監視するトピックです。
その値は、`--` の後ろではなく、`connect` の `--param` に書いてください。
`--` の後ろはすべてフィンガープリントに含まれるので、そこに値を書くと、値ごとに別の常駐プロセスが必要になります。

```sh
autospawn connect --name example-events --param topic=proj-a -- \
  op run -- \
  autospawn serve --param topic=EXAMPLE_TOPIC -- \
  example-tool watch
```

`serve --param topic=EXAMPLE_TOPIC` は、キー `topic` を宣言し、その値を子プロセスに `EXAMPLE_TOPIC` として渡します。
接続ごとに、その値を持つ別の子プロセスが起動し、すべての接続が一つの常駐プロセスと一回の承認を共有します。
値は子プロセスのコマンドラインには入らないので、呼び出し元が `-e` のようなオプションを足すことはできません。

serve は次のものを拒否します。

- 宣言していないキー(`bad_param` の応答を返します)。
- 制御文字を含む値、または 4096 バイトを超える値。
- 起動時に、serve 自身の環境にすでにある名前、または `AUTOSPAWN_` で始まる名前の宣言。
  そうしないと、プログラムが認証情報を送る先の URL のように、設定で決めた値を呼び出し元が置き換えられてしまうためです。

プログラムは、受け取った値を信頼できない入力として扱う必要があります。

## ファイル

autospawn は、名前ごとにソケット、ログファイル、起動ロックをベースディレクトリ配下に保持します。

- `$AUTOSPAWN_DIR` が設定され、空でない場合はその値を使い、それ以外の場合は `$HOME/.local/state/autospawn` を使います。
- `<base>/<name>.sock`、`<base>/<name>.log`、`<base>/<name>.spawn` を使います。
  起動ロックは、connect が常駐プロセスを起動している間だけ存在します。
  その時点で強制終了された connect はロックを残すことがあります。
  次の connect は、そのロックが自身の `--timeout` より古くなると削除します。

ベースディレクトリはモード 0700 で作成されます。
すでに存在するディレクトリの権限がこれより緩い場合、または所有者が異なる場合、autospawn はそのディレクトリの使用を拒否します。

## 一致を識別するもの

connect は、環境変数ではなく `--` の後に渡された argv からフィンガープリントを計算します。
クライアントがそれぞれ独自の環境変数を追加するためです。
同じ `--name` で異なるコマンドを指定した2番目の connect は `fingerprint_mismatch` を受け取り、`stop` を示すメッセージとともに終了コード 1 で終了します。
この場合、autospawn は利用者に代わって常駐プロセスを再起動しません。
同じ名前を使う二つのクライアント設定が一致しない場合、自動再起動すると各クライアントが互いの常駐プロセスを再起動し続けるためです。

フィンガープリントは argv だけを対象とするため、`op://` 参照などの環境変数を変更してもフィンガープリントは変わりません。
このような変更後は `stop` を実行してください。
これにより、次の connect が新しい値を取得する常駐プロセスを起動します。

## セキュリティ特性

利用者として動作し、`<base>/<name>.sock` に到達できるすべてのプロセスが常駐プロセスに接続できます。
常駐プロセスは、そのプロセスのために設定済みのプログラムを起動し、`op run` などのラッパーが解決したシークレットを保持する環境を渡します。
呼び出し元はプログラムやその引数を変更できませんが、利用者と同じ方法でプログラムを使用でき、`serve` が宣言したパラメーターの値を選べます。
ベースディレクトリの権限検査は他の利用者を排除しますが、利用者自身のプロセス同士は区別しません。

## 設計

アーキテクチャ、設計上の決定、既知の制限については、[docs/](docs/README.md) を参照してください。

## ライセンス

MIT
