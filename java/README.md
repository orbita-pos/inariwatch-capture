# inariwatch-capture (Java)

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — Java 21+.

Payload-compatible with the Node, Python, Go, and Rust SDKs in this monorepo. Same DSN, same event schema, **byte-identical fingerprint algorithm** so an error captured in a Java service dedupes against the same error captured anywhere else.

## Quick start

```java
import com.inariwatch.capture.Capture;
import com.inariwatch.capture.Config;

public class Main {
    public static void main(String[] args) {
        Capture.init(new Config()
            .dsn(System.getenv("INARIWATCH_DSN"))
            .environment("production")
            .release("1.0.0"));

        try {
            doStuff();
        } catch (Exception e) {
            Capture.captureException(e, null);
        } finally {
            Capture.flush(2);
        }
    }
}
```

## Build

```
mvn package
```

Maven 3.9+ and JDK 21+ required.

## Cross-SDK conformance

`src/test/java/com/inariwatch/capture/FingerprintGoldenVectorsTest.java` loads `shared/fingerprint-test-vectors.json` (at the monorepo root) and asserts byte-equivalence against every other SDK. Run with `mvn test`.

## License

MIT.
