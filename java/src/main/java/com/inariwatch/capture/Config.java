package com.inariwatch.capture;

import java.util.function.Function;

/**
 * Builder-style configuration for {@link Capture#init(Config)}.
 */
public class Config {
    public String dsn;
    public String environment;
    public String release;
    public boolean silent;
    /** Optional pre-send filter — return null to drop the event. */
    public Function<ErrorEvent, ErrorEvent> beforeSend;

    public Config dsn(String v) { this.dsn = v; return this; }
    public Config environment(String v) { this.environment = v; return this; }
    public Config release(String v) { this.release = v; return this; }
    public Config silent(boolean v) { this.silent = v; return this; }
    public Config beforeSend(Function<ErrorEvent, ErrorEvent> v) { this.beforeSend = v; return this; }
}
