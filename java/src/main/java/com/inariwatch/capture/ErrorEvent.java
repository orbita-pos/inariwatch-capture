package com.inariwatch.capture;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Wire-compatible error event payload. Field names match the Node, Python,
 * Go, and Rust SDKs byte-for-byte so a single backend ingest handler can
 * process events from any runtime without conditionals.
 */
@JsonInclude(JsonInclude.Include.NON_EMPTY)
public class ErrorEvent {

    public String fingerprint;
    public String title;
    public String body;
    /** "critical" | "error" | "warning" | "info" | "debug" */
    public String severity;
    public String timestamp;
    public String environment;
    public String release;

    @JsonProperty("eventType")
    public String eventType;

    public String runtime;

    public Map<String, Object> user;
    public Map<String, String> tags = new HashMap<>();
    public Map<String, Object> git;

    public Map<String, Object> env;
    public Map<String, Object> request;

    public List<Map<String, Object>> breadcrumbs;
    public Map<String, Object> context = new HashMap<>();
    public Map<String, Object> metadata = new HashMap<>();
}
