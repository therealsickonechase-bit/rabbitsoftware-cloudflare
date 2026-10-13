import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

/** Same-host durable mailbox adapter; responses are versioned JSON, not parsed objects. */
public final class VaultMailbox {
    private final Path node;
    private final Path entrypoint;
    private final Path vault;
    private final String sender;
    private final String recipient;

    public VaultMailbox(Path node, Path entrypoint, Path vault, String sender, String recipient) {
        if (!node.isAbsolute() || !entrypoint.isAbsolute() || !vault.isAbsolute()) {
            throw new IllegalArgumentException("Use absolute Node, mailbox CLI and vault paths.");
        }
        this.node = node;
        this.entrypoint = entrypoint;
        this.vault = vault;
        this.sender = name(sender);
        this.recipient = name(recipient);
    }

    private static String name(String value) {
        if (value == null || !value.matches("[a-z][a-z0-9-]{0,63}")) {
            throw new IllegalArgumentException("Use lowercase sender/recipient names of 1-64 characters.");
        }
        return value;
    }

    private static String hash(String value) {
        if (value == null || !value.matches("[a-f0-9]{64}")) {
            throw new IllegalArgumentException("Use a SHA-256 task, message or artifact ID.");
        }
        return value;
    }

    private static String json(String value) {
        if (value == null) throw new IllegalArgumentException("JSON text must not be null.");
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (Character.isHighSurrogate(character)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    throw new IllegalArgumentException("Text contains invalid Unicode.");
                }
                result.append(character).append(value.charAt(++index));
            } else if (Character.isLowSurrogate(character)) {
                throw new IllegalArgumentException("Text contains invalid Unicode.");
            } else if (character == '"' || character == '\\') {
                result.append('\\').append(character);
            } else if (character < 32) {
                result.append(String.format("\\u%04x", (int) character));
            } else {
                result.append(character);
            }
        }
        return result.append('"').toString();
    }

    private static String output(Path path) throws IOException {
        if (Files.size(path) > 1024 * 1024) throw new IOException("Mailbox response exceeds 1 MiB.");
        return Files.readString(path, StandardCharsets.UTF_8).trim();
    }

    private String command(String action, String value, boolean inputJson) throws IOException, InterruptedException {
        if (inputJson && value.getBytes(StandardCharsets.UTF_8).length > 128 * 1024) {
            throw new IllegalArgumentException("Mailbox CLI JSON exceeds 128 KiB; split results without truncation.");
        }
        Path directory = Files.createTempDirectory("vault-java-mailbox-");
        Path input = directory.resolve("input.json");
        Path stdout = directory.resolve("stdout.json");
        Path stderr = directory.resolve("stderr.txt");
        Process process = null;
        try {
            if (inputJson) Files.writeString(input, value, StandardCharsets.UTF_8);
            process = new ProcessBuilder(node.toString(), entrypoint.toString(), "--vault", vault.toString(),
                    action, inputJson ? input.toString() : value)
                    .redirectOutput(stdout.toFile()).redirectError(stderr.toFile()).start();
            if (!process.waitFor(30, TimeUnit.SECONDS)) throw new IOException("Mailbox CLI timed out; verify persisted state before retrying the same key.");
            if (process.exitValue() != 0) throw new IOException("Mailbox CLI failed: " + output(stderr));
            String response = output(stdout);
            if (!response.startsWith("{") || !response.endsWith("}")) throw new IOException("Mailbox returned a non-object JSON response.");
            return response;
        } finally {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
                process.waitFor();
            }
            Files.deleteIfExists(input);
            Files.deleteIfExists(stdout);
            Files.deleteIfExists(stderr);
            Files.delete(directory);
        }
    }

    public String send(String key, String kind, String content) throws IOException, InterruptedException {
        if (key == null || !key.matches("[a-zA-Z0-9._:-]{1,128}")) throw new IllegalArgumentException("Use a stable message key of 1-128 safe characters.");
        if (!"code".equals(kind) && !"handoff".equals(kind) && !"task-receipt".equals(kind)) throw new IllegalArgumentException("Invalid message kind.");
        if (content == null || content.isBlank() || content.indexOf('\0') >= 0
                || content.getBytes(StandardCharsets.UTF_8).length > 65536) throw new IllegalArgumentException("Retained content must contain 1-65536 UTF-8 bytes.");
        return command("--send", "{\"version\":1,\"sender\":" + json(sender) + ",\"recipient\":" + json(recipient)
                + ",\"key\":" + json(key) + ",\"kind\":" + json(kind)
                + ",\"route\":\"local\",\"share\":false,\"content\":" + json(content) + "}", true);
    }

    public String reportTask(String task, String revision, String status, String result) throws IOException, InterruptedException {
        hash(task);
        if (revision == null || !revision.matches("[a-zA-Z0-9._-]{1,32}")) throw new IllegalArgumentException("Use a stable result revision of 1-32 safe characters.");
        if (!"completed".equals(status) && !"failed".equals(status) && !"blocked".equals(status)) throw new IllegalArgumentException("Use a terminal task status.");
        if (result == null || result.isBlank()) throw new IllegalArgumentException("Task result must not be empty.");
        String content = "{\"version\":1,\"task\":" + json(task) + ",\"revision\":" + json(revision)
                + ",\"status\":" + json(status) + ",\"result\":" + json(result) + "}";
        return send("task:" + task + ":" + revision, "task-receipt", content);
    }

    public String completeTask(String task, String revision, String result) throws IOException, InterruptedException {
        return reportTask(task, revision, "completed", result);
    }

    public String receive() throws IOException, InterruptedException {
        return command("--receive", sender, false);
    }

    public String read(String id) throws IOException, InterruptedException {
        return command("--read", sender + ":" + hash(id), false);
    }

    public String acknowledge(String id, String artifact) throws IOException, InterruptedException {
        return command("--ack", "{\"recipient\":" + json(sender) + ",\"id\":" + json(hash(id))
                + ",\"artifact\":" + json(hash(artifact)) + "}", true);
    }

    public static void main(String[] args) throws IOException, InterruptedException {
        if (args.length < 6) throw new IllegalArgumentException("Usage: VaultMailbox NODE CLI VAULT SENDER RECIPIENT receive|complete|read|ack [values]");
        VaultMailbox mailbox = new VaultMailbox(Path.of(args[0]), Path.of(args[1]), Path.of(args[2]), args[3], args[4]);
        String response;
        switch (args[5]) {
            case "receive":
                if (args.length != 6) throw new IllegalArgumentException("receive needs no values.");
                response = mailbox.receive();
                break;
            case "complete":
                if (args.length != 9) throw new IllegalArgumentException("complete needs TASK_SHA256 REVISION RESULT_FILE.");
                Path path = Path.of(args[8]);
                if (Files.size(path) > 65536) throw new IllegalArgumentException("Result file exceeds 64 KiB.");
                response = mailbox.completeTask(args[6], args[7], Files.readString(path, StandardCharsets.UTF_8));
                break;
            case "read":
                if (args.length != 7) throw new IllegalArgumentException("read needs MESSAGE_SHA256.");
                response = mailbox.read(args[6]);
                break;
            case "ack":
                if (args.length != 8) throw new IllegalArgumentException("ack needs MESSAGE_SHA256 ARTIFACT_SHA256.");
                response = mailbox.acknowledge(args[6], args[7]);
                break;
            default:
                throw new IllegalArgumentException("Unknown mailbox action.");
        }
        System.out.println(response);
    }
}
