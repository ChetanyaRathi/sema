---
title: "LSP Client For JetBrains IDEs"
source: "https://www.j-a.dev/lsp-dap/jetbrains-lsp-client/"
author:
published:
created: 2026-06-07
description:
tags:
  - "clippings"
---
This page introduces the j-a.dev LSP client and explains how to use it to add LSP support to a JetBrains IDE plugin.

Version 0.3.13

Gradle Plugin Version 0.3.4

Please note that the LSP implementation is still experimental. This page is work-in-progress.

## Adding LSP Support to a JetBrains Plugin

The LSP client is distributed as a library and not as a plugin. As a library, it can be bundled with a plugin instead of introducing a dependency on a plugin.

The LSP client is written in Kotlin. It relies on Kotlin coroutines and uses the IDE’s features for coroutine-based concurrency. The best way to use it is to use Kotlin. But it’s still possible to reference the LSP client and its classes from Java code.

### Gradle Setup

#### Maven coordinates

The LSP library and its sublibraries are published on [Maven Central](https://mvnrepository.com/artifact/dev.j-a.ide):

```
dev.j-a.ide:lsp-client:...
```

There are several libraries provided, e.g. to integrate LSP4J with Kotlin coroutines, a testframework and more.

### Setup Gradle Version Catalog

#### gradle/libs.versions.toml

```toml
[versions]
# Version of the j-a.dev LSP library,
# it's used with the platform version to replace version "default"
lsp-library = "0.3.13"

[libraries]
# Default is replaced by the resolutionStrategy
lsp-client = "dev.j-a.ide:lsp-client:default"
```

#### build.gradle.kts

```kotlin
val lspLibraryVersion = rootProject.libs.versions.lsp.library.get()

plugins {
    // Plugin to relocate the LSP library package to make it unique to your plugin
    // and to exclude dependencies already contained in the IDE distribution.
    id("dev.j-a.ide.lsp") version "0.3.4"
}

shadowLSP {
    // Package to contain the relocated LSP library packages.
    // This must be unique to your plugin.
    packagePrefix = "dev.j_a.gosupport.lsp_support"

    // LSP features, which need a configured language ID, 
    // are enabled for languages specified here 
    // enabledLanguageIds = setOf("go")
}

dependencies {
    implementation(rootProject.libs.lsp.client)
}

// Replace version "default" of LSP and DAP libraries with the version for the current platform
configurations.all {
    resolutionStrategy.eachDependency {
        if (requested.group == "dev.j-a.ide" && requested.version == "default") {
            useVersion("$lspLibraryVersion.$platformVersion")
            because("LSP platform version")
        }
    }
}
```

### Plugin Setup

You have to implement at least two interfaces and add a `ProjectActivity` to enable the LSP integration.

#### Implement LanguageServerSupport

An implementation of `dev.j_a.ide.lsp.api.LanguageServerSupport` is the entry point to support a specific LSP server. Method `fileOpened` is called when a new editor is opened.

Your implementation decides if an LSP server should be launched for the edited file. Class `BaseLanguageServerSupport` is a base implementation of the interface to simplify implementations.

```kotlin
// Implementation of LanguageServerSupport
// must be a Kotlin object or a Java singleton.
object GoplsLanguageServerSupport : BaseLanguageServerSupport(
    "dev.j_a.ide.gosupport",
    "Gopls Support"
) {
    override fun fileOpened(
        project: Project,
        file: VirtualFile,
        serverStarter: LanguageServerSupport.LanguageServerStarter
    ) {
        if (file.extension == "go") {
            serverStarter.ensureStarted(GoplsServerDescriptor(project))
            // --> GoplsServerDescriptor is implemented in the next step
        }
    }
}
```

#### Implement LanguageServerDescriptor

You need to implement `dev.j_a.ide.lsp.api.descriptor.LanguageServerDescriptor` to tell the LSP client how to launch your LSP server. The LSP library provides base classes for the most common scenarios.

Extend `dev.j_a.ide.lsp.api.descriptor.CommandLineLanguageServerDescriptor` if your LSP server uses STDIO to communicate with clients.

```kotlin
class GoplsServerDescriptor(project: Project) : CommandLineLanguageServerDescriptor(
    project,
    GoplsLanguageServerSupport // <-- your LanguageServerSupport object
) {
    override fun isSupported(file: VirtualFile): Boolean {
        // Usually the same as in your LanguageServerSupport, 
        // if you always want to send didOpen/didChange/didClose events.
        return file.extension == "go"
    }

    override fun createCommandLine(): GeneralCommandLine {
        // --> make sure to check for a null value
        val executable = requireNotNull(PathEnvironmentVariableUtil.findInPath("gopls"))
        return GeneralCommandLine(executable.toString()).withParameters("serve")
    }
}
```

#### Register Your LSP Support With a Startup Activity

Finally, you have to tell the LSP library about your implementation of `LanguageServerSupport`. The LSP library provides the abstract base class `RegisterLanguageServerSupportActivity` to make it easier to use.

```kotlin
class GoplsRegisterLanguageServerActivity
    : RegisterLanguageServerSupportActivity(GoplsLanguageServerSupport)
```

#### Set Up plugin.xml

```xml
<idea-plugin xmlns:xi="http://www.w3.org/2001/XInclude">
    <!-- plugin.xml snippet bundled with the lsp-client library.
         It registers extensions, which don't require a specific language. -->
    <xi:include href="/META-INF/plugin-lsp-client.xml"/>

    <extensions defaultExtensionNs="com.intellij">
        <!-- Project activity to register your LSP server type 
             and to launch it when editors are opened. -->
        <postStartupActivity
                implementation="dev.j_a.gosupport.lsp.GoplsRegisterLanguageServerActivity"/>
    </extensions>
</idea-plugin>
```

Now, after the project finished loading, the open files are passed to `fileOpened(...)` of your `LanguageServerSupport`.

Later, when a new editor is opened, the same method is called to let your plugin decide if an LSP server should be launched or not.

## Optional LSP Features

### Status Bar Widget

It’s possible to show a status bar item when your LSP server is active. By default, the item is not enabled and shown.

The status bar item displays the current status of the LSP server. It offers menu items to restart or stop a running server and to open a tool window to help debug LSP messages.

To show the icon in the status bar, you have to implement a class and register it in your plugin.xml

#### Implement LanguageServerStatusBarWidgetFactory

```kotlin
class GoplsStatusBarWidgetFactory
    : LanguageServerStatusBarWidgetFactory("your_status_bar_id") // same ID as in your plugin.xml
```

#### Register statusBarWidgetFactory

```xml
<idea-plugin>
    <extensions defaultExtensionNs="com.intellij">
        <statusBarWidgetFactory
                id="your_status_bar_id"
                implementation="dev.j_a.lsp.example.gopls.GoplsStatusBarWidgetFactory"/>
    </extensions>
</idea-plugin>
```

### Optional Language Features

Some of the extensions registered in a `plugin.xml` configuration of a JetBrains plugin are tied to a specific [Language](https://plugins.jetbrains.com/docs/intellij/custom-language-support.html). For example, a `<lang.psiStructureViewFactory>` extension can only be defined for a specific language, e.g. `JSON`.

The LSP library uses generic extensions whenever possible. But because some of the extensions have to be defined for a language, that’s not always possible. If your LSP server is active for a language other than `textmate` or `TEXT`, you have to configure the languages to activate optional, language-specific features of the LSP library for them.

The optional, language-specific features are:

- Folding support
- PSI Structure view with support for Prev/Next method and sticky lines
- Signature help
- Type hierarchy
- Call hierarchy
- Go To Super Type
- Import optimizer

They’re only available if your LSP server supports the underlying LSP server capabilities.

To enable the features, please configure `enabledLanguageIds` in your Gradle build setup:

```kotlin
shadowLSP {
    enabledLanguageIds = setOf("your-custom-language-id")
    // for example:
    // enabledLanguageIds = setOf("JSON", "yaml)
}
```

## Customizing LSP Support

Most features of the LSP client can be customized to suit your needs.

### Controlling LSP Client Capabilities

Override `LanguageServerDescriptor.customize(capabilities: ClientCapabilities)` to update the default client capabilities before they’re sent to the LSP server during the initialization workflow.

For example, you could pass extended or custom client capabilities if your LSP server supports it.

### Customizing Workspace Folders

Workspace folders are sent with the `initialize` request. They’re also used by the server-to-client request `workspace/workspaceFolders` and by the client-to-server notification `workspace/didChangeWorkspaceFolders`.

`val workspaceFolders: WorkspaceFolderProvider` of your `LanguageServerDescriptor` defines the workspace folders to use with your LSP server. By default, the project’s base directories are used. See the IDE’s `BaseProjectDirectories` for details.

```kotlin
class YourServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val workspaceFolders: WorkspaceFolderProvider = object : CustomBaseDirectories() {
        override fun findWorkspaceFolders(project: Project): Collection<VirtualFile> {
          // fixme: return your own workspace folder. 
          //    project.getBaseDirectories() is used as default. 
        }
    } 
}
```

### Customizing Server Settings

LSP servers take configurations

```kotlin
class YourServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override fun customize(initParams: InitializeParams) {
        initParams.initializationOptions = JsonObject().apply {
            add("hints", JsonObject().apply {
                addProperty("assignVariableTypes", true)
                addProperty("constantValues", true)
                addProperty("functionTypeParameters", true)
                addProperty("parameterNames", true)
                addProperty("rangeVariableTypes", true)
            })
        }
    }
}
```

Override `LanguageServerDescriptor.customize(capabilities: ClientCapabilities)` to update the default client capabilities before they’re sent to the LSP server during the initialization workflow.

For example, you could pass extended or custom client capabilities if your LSP server supports it.

### Preventing Text Synchronization Events

If you would like to turn off events `didOpen`, `didChange` and `didClose`, then return `false` from `LanguageServerDescriptor.isSupported(VirtualFile)`.

```kotlin
class YourServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override fun isSupported(file: VirtualFile): Boolean {
        return false
    }
}
```

### Disabling LSP Features

There are two different ways to turn off a certain feature of the LSP client.

#### Using LSP Client Capabilities

The best way is to turn off the matching client capabilities in the `customize(ClientCapabilities)` method of your server descriptor. In this case the LSP server will know that the feature is unavailable.

```kotlin
// Inside your LanguageServerDescriptor implementation
override fun customize(capabilities: ClientCapabilities) {
    capabilities.textDocument.rename = null
}
```

#### Using ClientFeature

If you’d like to suppress a feature without changing the client capabilities, override `LanguageServerDescriptor.isSupported(feature: ClientFeature): Boolean` and return `false` for the feature you’d like to turn off.

All features of the LSP client are registered inside `dev.j_a.ide.lsp.api.clientCapabilities.ClientFeatures` and you can compare against these items to detect if a particular feature should be disabled.

The `isSupported` method is only called if both server capabilities and client capabilities support the feature. The LSP server will assume that the client supports the feature.

```kotlin
// Inside your LanguageServerDescriptor implementation
override fun isSupported(feature: ClientFeature): Boolean {
    return when (feature) {
        ClientFeatures.TextDocument.Rename -> false
        else -> true
    }
}
```

### Customizing LSP Features

Most features can be customized to suit your needs.

Property `val clientCustomization: ClientCustomization` of your `LanguageServerDescriptor` is the entry point. The default value provides a reasonable, generic implementation for most languages.

Override this property to selectivly customize a certain feature.

```kotlin
// Inside your LanguageServerDescriptor implementation
class YourLanguageServerDescriptor : LanguageServerDescriptor {
    override val clientCustomization: ClientCustomization = GoplsClientCustomization
}

object GoplsClientCustomization : ClientCustomization() {
    // Customize folding ranges, 
    // but keep the default implementation of everything else.
    override val foldingSupport: ClientFoldingSupport = object : ClientFoldingSupport() {
        override fun preProcess(range: FoldingRange) {
            // https://github.com/golang/go/issues/71489
            if (range.endLine > range.startLine && range.endCharacter == null) {
                range.endCharacter = 0
            }
        }
    }
}
```

## Examples

### Gopls LSP Plugin

[go-support-lsp](https://github.com/jansorg/go-support-lsp) is a comprehensive sample implementation using this LSP library. The source code is available.

Its syntax highlighting relies on JetBrains’ TextMate plugin. Every other feature is integrated with the help of the [gopls](https://github.com/golang/tools/tree/master/gopls) LSP server.

### Swift Support

The [Swift Support plugin](https://plugins.jetbrains.com/plugin/22150) uses this LSP library. The plugin provides its own lexer, parser and PSI and selected features based on it like the structure view. Most advanced features are integrated via LSP and rely on the SourceKit-LSP server.

The source code is not available, as it’s a paid plugin.

## Features

This section provides detailed documentation of the supported LSP features.

### Lifecycle of an LSP Server

By default, an LSP server is started when a supported file is opened, and it’s shut down when the project it was started for is closed.

As soon as a file is opened in an editor, method `fileOpened(project, file, serverStarter)` is invoked for all registered `LanguageServerSupport`.

If an implementation of `fileOpened()` decides that the server should be launched by invoking `serverStarter.ensureStarted(descriptor)`, the LSP server defined by `descriptor` is started.

Because the initialization of an LSP server is usually a heavy or slow operation, the server is kept running until the project is closed. A manual shutdown of a server using the API is still possible with `LanguageServerManager.stopServer(configuration)`.

If an LSP server fails to launch or terminates unexpectedly, then it’s automatically restarted up to 3 times. If the initialization takes more than 10 seconds, then a restart is attempted.

Servers, which are initializing, restarting or shutting down are not made available by the public API. `LanguageServerManager` does only provide access to fully initialed LSP server configurations.

### LSP Request Handling

Under the hood, Kotlin coroutines are heavily used to handle requests to the LSP server. Whenever possible, the IDE’s current coroutine scope is used to launch a request. If the IDE’s scope is cancelled, e.g. because the user made changes in an editor, the LSP client cancels the request and notifies the LSP server about the cancellation using `$/cancelRequest`.

By default, a timeout is applied to request to the LSP server.

### Document Synchronization

All running LSP servers are notified when a file is opened in an editor, modified or closed.

The LSP client supports all position encodings defined in the LSP specification:

- UTF-8
- UTF-16
- UTF-32

Because IntelliJ is using UTF-16 internally, it’s the preferred position encoding.

### Diagnostics

An annotator is used to show diagnostics in code editors.

All three types of LSP diagnostics are supported:

- [Publish Diagnostics](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_publishDiagnostics)
- [Pull Diagnostics](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_pullDiagnostics)
- [Workspace Diagnostics](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#workspace_diagnostic), including support for incremental updates. Workspace diagnostics are refreshed when the server initiates a refresh via [`workspace/diagnostics/refresh`](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#diagnostic_refresh)

By default, all types of diagnostics are enabled. If both pull and publish diagnostics are available for a file, then both are merged.

Workspace diagnostics are only retrieved if there are no pull and publish diagnostics for a file. The LSP spec requires this: *diagnostics from a document pull should win over diagnostics from a workspace pull*. It’s possible to override this by customzing method `ClientDiagnosticSupport#isWorkspaceDiagnosticsEnabled` in your descriptor’s client customization.

#### Customization

If necessary, the support for diagnostics can be customized. `ClientFeatures.TextDocument.PullDiagnostics` controls the state of pull diagnostics. `ClientFeatures.Workspace.Diagnostics` controls the state of workspace diagnostics.

Publish diagnostics are not controlled by client feature, because they are initiated by the server. Publish diagnostics are controlled by client capabilities only:

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override fun customize(capabilities: ClientCapabilities) {
        // tell the server not to publish diagnostics
        capabilities.textDocument.publishDiagnostics = null
    }
}
```

Diagnostics can be customzied via `ClientDiagnosticSupport`. Please refer to the API documentation of the code to learn more about customizing diagnostics.

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val clientCustomization: ClientCustomization = object : ClientCustomization() {
        override val diagnostics: ClientDiagnosticSupport = object : ClientDiagnosticSupport() {
            // ...
        }
    }
}
```

### Code Completion

Code completion based on the [LSP completion request](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_completion) is fully supported.

All defined types of insertions are supported: simple insertion of `insertText` or `label`, text edits with insert and replacement ranges, additional text edits and command execution after a completion was inserted.

The LSP server’s global trigger characters are used to automatically show the completion popup. Individual commit characters of a completion item are not supported by JetBrains IDEs.

Rendering documentation of completion support both plain text and Markdown. By default, Markdown content is colored with the IDE’s settings for syntax highlighting.

Snippets are supported, including regular expression support and modifiers like `/upcase`. The LSP specification is unclear about some aspects of regular expression handling. `/capitalize` is implemented to capitalize every word of the referenced pattern match. Options `i`, `m` and `s` are supported as regular expression options.

Because JetBrains IDEs don’t support nested placeholders (aka live-templates), they’re split into multiple smaller placeholders. For example, `${2:prefix${1:middle}suffix}` is shown as three placeholders `middle`, then `prefix`, then `suffix`.

A completion item is resolved when its `documentation` is requested. A resolve request is only sent if the server supports it.

#### Customization

The implementation of LSP code completion is customized via `ClientCompletionSupport`:

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val clientCustomization: ClientCustomization = object : ClientCustomization() {
        override val completionSupport: ClientCompletionSupport = object : ClientCompletionSupport() {
          // ...
        }
    }
}
```

`ClientCompletionSupport.isEnabled(VirtualFile)` allows to suppress completions for a particular file.

`ClientCompletionSupport.preprocessSnippet(String)` allows to modify LSP snippets before they’re processed by the LSP client. Snippets are processed when they’re inserted by the user. This method is called before the LSP client’s default snippet preprocessing.

`ClientCompletionSupport.isDefaultSnippetProcessingEnabled` defines if the default preprocessing of LSP snippets is enabled.  
By default, if a snippet contains only a single, but empty placeholder, then its replaced with a tabstop `$0`. For example, `method_name(${1:})` becomes `method_name($0)`.

`ClientCompletionSupport.showOtherIdeCompletions(VirtualFile, Language)` allows to suppress completions of other plugins. By default, other completions are hidden in TextMate files because they’re word-based and most often not helpful. Completions for all other types of files are shown unless the implementation of this method hides them.

`ClientCompletionSupport.customize(LookupElement, CompletionItem)` allows to customize the appearance of the items shown for completion.

`ClientCompletionSupport.icon(CompletionItem): Icon?` can be used if only the item of a completion item should be modified.

### Semantic Tokens

LSP’s [semantic tokens](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_semanticTokens) are applied by an annotator.

Request `textDocument/semanticTokens/full/delta` is used if supported by the LSP server to retrieve the changes since previous request.  
Request `textDocument/semanticTokens/range` is not supported because an annotator does not provide a range to update in the editor.

#### Customization

`object SemanticTokenTypes` provides all semantic tokens defined by the LSP specification.  
`object SemanticTokenModifiers` provide all modifiers of semantic token. When the LSP `initialize` request is sent, the registered tokens and modifiers are collected and sent to the LSP server.

The best way to register and to customize your tokens and modifiers is to implement a Kotlin `object`, using `val` to keep references of your custom tokens and modifiers.

```kotlin
import dev.j_a.ide.lsp.api.semanticTokens.SemanticTokenModifiers
import dev.j_a.ide.lsp.api.semanticTokens.SemanticTokenTypes

object MySemanticTokenSupport : DefaultSemanticHighlightingSupport() {
    // custom token types
    private val BracketType = SemanticTokenTypes.register("bracket")
    
    // custom token modifiers
    private val GlobalScopeModifier = SemanticTokenModifiers.register("globalScope")
    
    override fun findTextAttributesWithModifiers(
        token: SemanticTokenType,
        modifiers: Set<SemanticTokenModifier>
    ): TextAttributesKey? {
      if (token == BracketType && GlobalScopeModifier in modifiers) {
        return yourCustomAttributesKey
      }
      return super.findTextAttributesWithModifiers(token, modifiers)
    }
}
```

`MySemanticTokenSupport` is referenced in your client customization:

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val clientCustomization: ClientCustomization = object : ClientCustomization() {
        override val semanticTokenSupport: DefaultSemanticHighlightingSupport = MySemanticTokenSupport
    }
}
```

### Code Lenses

Code lenses are implemented as inlay hints.

#### Customization

Support for code lenses is customized by `dev.j_a.lsp.api.descriptor.ClientCodeLensSupport`. Method `ClientCodeLensSupport.addCodeLensInlays` allows to apply your own logic how inlays are inserted.

Class `BlockCodeLensSupport` is the default implementation and adds code lenses above a line.

If you would like to insert all code lenses at the end of a line, then `EndOfLineInlineCodeLensSupport` is available:

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val clientCustomization: ClientCustomization = object : ClientCustomization() {
        override val codeLensSupport: ClientCodeLensSupport = ClientCodeLensSupport.EndOfLineInlineCodeLensSupport()
    }
}
```

### Folding

If a server does not define the placeholder, then `...` is used as a fallback value. See below how to customize the placeholder.

#### Customization

Support for code folding is customized by `ClientFoldingSupport`.

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val clientCustomization: ClientCustomization = object : ClientCustomization() {
        override val foldingSupport: ClientFoldingSupport = object : ClientFoldingSupport() {
            // ...
        }
    }
}
```

`ClientFoldingSupport.getPlaceholderText(...)` allows to customize the placeholder of a folded section. By default, it’s the placeholder provided by LSP or “…” if no value is provided.

`ClientFoldingSupport.preProcess(...)` allows to preprocess the LSP folding range before it’s applied to an editor.

`ClientFoldingSupport.isCollapseByDefault(...)` decides if a section should be collapsed by default. Comments at the start of a file, imports and custom folding regions are collapsed, but only if the corresponding IDE settings is enabled.

### Inlay Hints

Inlay hints are implemented as declarative inlays.

Ctrl-clicking on an inlay inserts it into the document text.  
If the inlay hint defines a command, then it’s executed when the inlay is clicked.  
If the inlay hint defines a location, then the editor jumps to the location when the inlay is clicked.

The context menu of an inlay hint allows to disable all inlay hints of the same type.

#### Customization

Inlay hints are customized by `ClientInlayHintSupport`.

`ClientInlayHintSupport.supportedLanguages(...)` should be implemented to provide valid entries in the IDE’s inlay hint settings.

### Formatting

Formatting is implemented as a `AsyncDocumentFormattingService`.

#### Customization

Support for document formatting is customized by `ClientFormattingSupport`.

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val clientCustomization: ClientCustomization = object : ClientCustomization() {
        override val formattingSupport: ClientFormattingSupport = object : ClientFormattingSupport() {
            // ...
        }
    }
}
```

`ClientFormattingSupport.customize(...)` allows to customize the formatting options sent to the LSP server. The default values are based on the IDE’s formatting settings of the current file.

### Document On Type Formatting

Document on type formatting is implemented using `TypedHandlerDelegate` and `EnterHandlerDelegate`. To avoid blocking the UI thread, the formatting is done in a background thread and only applied if the document did not change in the meantime.

This delayed formatting can appear to be applied with a slight delay, but it’s required to avoid blocking the UI thread.

### Document Colors

Document colors are displayed as inlay hints.

These color inlay hints are clickable. If a new color is picked, then the server is asked for presentations and the preferred presentation is applied.

#### Customization

Support for document colors is customized by `ClientDocumentColorSupport`.

```kotlin
class YourLanguageServerDescriptor : CommandLineLanguageServerDescriptor(/*...*/) {
    override val clientCustomization: ClientCustomization = object : ClientCustomization() {
        override val documentColorSupport: ClientDocumentColorSupport = object : ClientDocumentColorSupport() {
            // ...
        }
    }
}
```

`ClientDocumentColorSupport.choosePreferredPresentation(...)` is used to choose the color to apply to a document. By default, the first presentation returned by the server is selected.

`ClientDocumentColorSupport.showAlpha` configures if the alpha channel should be displayed in the color picker. By default, it’s displayed.

### Signature Help

The extended context of the `textDocument/signatureHelp` request is supported, but trigger kind `TriggerCharacter` and the used trigger character are unavailable in the IDE’s parameter info.

Support for signature help is customized by `LanguageServerSignatureHelpSupport`.

### Workspace Symbols

The workspace symbols are used to implement “Go to class” and “Go to symbol”.

Symbols are only provided for running LSP servers. Servers are not started automatically when a user requests a symbol lookup by name.

If you would like to provide symbols even before the user opened the first support file, then make sure to call `LanguageServerManager.ensureServerStarted(descriptor)` to launch the server earlier. For example, use project activity to launch the server when a project is opened.

### DidChangeWatchedFiles Notification

Only changes to files on the local file system are send as `workspace/didChangeWatchedFiles` notifications.

Relative patterns are supported. Base directories of base paths are added to the native file system watcher.

### Workspace WillDeleteFiles

The notification is currently not sent for files nested in a deleted directory.

### Workspace WillDeleteFiles

The notification is currently not sent for files nested in a deleted directory.

## Open API

Some parts of the API are available as source code. Classes and methods of the open API are allowed to be used by plugins and will provide a stable API.

Classes of the open API are contained in the Maven/Gradle modules [lsp-core-openapi](https://mvnrepository.com/artifact/dev.j-a.ide/lsp-core-openapi) and [lsp-client-openapi](https://mvnrepository.com/artifact/dev.j-a.ide/lsp-client-openapi).

### Introduction to Concepts

A running LSP server is made available as a `dev.j_a.ide.lsp.api.LanguageServerConfiguration`. This configuration is the entry point to query and to communicate with an LSP server. It belongs to a specific project via property `LanguageServerConfiguration.project`.

A `LanguageServerConfiguration` belongs to a particular `LanguageServerDescriptor`, available via `LanguageServerConfiguration.descriptor`.

### LanguageServerManager

Service `dev.j_a.ide.lsp.api.LanguageServerManager` is the entry point to retrieve the available LSP servers. It provides several methods to retrieve and filter the available server configurations.

Additionally, there are a few `inline fun` helpers available to simplify Kotlin code using `LanguageServerManager`.

It allows to shut down and restart servers, but this should only be rarely needed.

### LanguageServerConfiguration

#### Retrieving a LanguageServerConfiguration

`LanguageServerManager` manages all available `LanguageServerConfiguration`.

#### Referencing a LanguageServerConfiguration

Because the underlying server of a `LanguageServerConfiguration` could terminate at any time, a reference to it should not be kept for a long time.

Instead, use `val id = serverConfiguration.id` to retrieve a pointer to a configuration. Later, retrieve the server configuration again via `id.find(project)`. If the server became unavailable in the meantime, then `null` is returned by the find method.

#### Using LanguageServerConfiguration

- `LanguageServerConfiguration.languageServerSupport` is the implementation of `LanguageServerSupport` which owns this server configurations
- `LanguageServerConfiguration.descriptor` is the `LanguageServerDescriptor`, which defined and customized the server configuration
- `LanguageServerConfiguration.serverCapabilities` provides the capabilities of the LSP server. It contains information about statically and dynamically registered capabilities.
- `LanguageServerConfiguration.serverInfo` provides name and version of the LSP server
- `LanguageServerConfiguration.server` is the `suspend` -friendly API to interact with the remote LSP server. `LanguageServerConfiguration.server.delegate` contains the original LSP4J server.
- `LanguageServerConfiguration.clientCapabilities` provides the capabilities of the LSP client, which were sent to the LSP server
- `LanguageServerConfiguration.ideClient` is the `suspend` -friendly API of the underlying LSP4J client. This should only rarely be needed.
- `LanguageServerConfiguration.lsp4jClient` is the underlying LSP4J client. This should only rarely be needed.

Method `fun isSupported(file, serverFeature, clientFeature): Boolean` of `LanguageServerConfiguration` is the main entry point to test if an LSP feature is available in the context defined by a `VirtualFile` and a `ClientFeature`.

For example, to check if `textDocument/definition` is enabled in the LSP client and if it’s supported on the server by a static or dyanamic registration:

```kotlin
configuration.isSupported(
    virtualFile, 
    ServerFeatures.TextDocument.GoToDefinition, 
    ClientFeatures.TextDocument.GoToDefinition
)
```

Method `fun sendRequest(action: suspend SuspendingLanguageServer<T>.() -> Unit)` is typically used to send a notification or a request, if a response is not needed.

```kotlin
fun sendRequest() {
    configuration.sendRequest {
        textDocumentService.definition(DefinitionParams(/*...*/))
    }
}
```

Method `suspend fun <R> sendRequestAsync(action: suspend SuspendingLanguageServer<T>.() -> R): R?` can be used to send a request and to wait for the response from the LSP server. The `action` block is executed in a coroutine scope matching the LSP server.

```kotlin
suspend fun sendAsyncRequest() {
    val definition = configuration.sendRequestAsync {
        textDocumentService.definition(DefinitionParams(/*...*/))
    }
}
```

If you’d like to execute a custom request, e.g. a custom request defined by a particular LSP server, then methods `fun sendCustomRequest(params: Any? = null, action: T.() -> CompletableFuture<*>)` and `suspend fun <R> sendCustomRequestAsync(params: Any? = null, action: T.() -> CompletableFuture<R>): R` are helpful, especially in the context of Kotlin Coroutines.

## Coverage of the LSP Specification

### Base Protocol

- ✅ `$/cancelRequest`
- ✅ `$/progress`
- ✅ partial response support

### Server Capabilities

- ✅ Static server capabilities
- ✅ Dynamic registration of server capabilities

### Client Capabilities

- ✅ Position encoding
- ✅ Document filters
- ❌ `AnnotatedTextEdit`

### Lifecycle Requests

- ✅ `initialize`
- ✅ `initialized`
- ✅ `shutdown`
- ✅ `exit`

### Text Document Service

#### Synchronization

- ✅ `textDocument/didOpen`
- ✅ `textDocument/didChange`
- ✅ `textDocument/didClose`
- ✅ `textDocument/willSave`
- ✅ `textDocument/didSave`

#### Language Features

- ✅ `textDocument/codeAction`
- ✅ `codeAction/resolve`
- ✅ `textDocument/codeLens`
- ✅ `codeLens/resolve`
- ✅ `textDocument/completion`
- ✅ `completionItem/resolve`
- ✅ `textDocument/declaration`
- ✅ `textDocument/definition`
- ✅ `textDocument/diagnostic`
- ✅ `textDocument/documentColor`
- ✅ `textDocument/colorPresentation`
- ✅ `textDocument/documentHighlight`
- ✅ `textDocument/documentLink`
- ✅ `textDocument/documentSymbol`
- ✅ `textDocument/foldingRange`
- ✅ `textDocument/formatting`
- ✅ `textDocument/hover`
- ✅ `textDocument/implementation`
- ✅ `textDocument/incomingCalls`
- ✅ `textDocument/inlayHint`
- ❌ `textDocument/inlineValue`
- ✅ `textDocument/linkedEditingRange`
- ❌ `textDocument/moniker`
- ✅ `textDocument/onTypeFormatting`
- ✅ `textDocument/prepareCallHierarchy`
- ✅ `textDocument/outgoingCalls`
- ✅ `textDocument/publishDiagnostics`
- ✅ `textDocument/rangeFormatting`
- ✅ `textDocument/references`
- ✅ `textDocument/prepareRename`
- ✅ `textDocument/rename`
- ✅ `textDocument/selectionRange`
- ✅ `textDocument/semanticTokens/full/delta`
- ✅ `textDocument/semanticTokens/full`
- ❌ `textDocument/semanticTokens/range`
- ✅ `textDocument/signatureHelp`
- ✅ `textDocument/prepareTypeHierarchy`
- ✅ `textDocument/subtypes`
- ✅ `textDocument/supertypes`
- ✅ `textDocument/typeDefinition`

### Workspace

- ❌ `telemetry/event` - server to client
- ✅ `workspace/applyEdit` - Server to client
- ✅ `workspace/codeLens/refresh` - Server to client
- ✅ `workspace/configuration`
- ✅ `workspace/diagnostic/refresh` - Server to client
- ✅ `workspace/diagnostic`
- ❌ `workspace/didChangeConfiguration`
- ✅ `workspace/didChangeWatchedFiles`
- ✅ `workspace/didChangeWorkspaceFolders`
- ✅ `workspace/executeCommand`
- ❌ `workspace/inlineValue/refresh` - Server to client
- ✅ `workspace/semanticTokens/refresh` - Server to client
- ✅ `workspace/showDocument` - server to client
- ✅ `workspace/showMessageRequest` - server to client
- ✅ `workspace/showMessage` - server to client
- ✅ `workspace/symbol`
- ✅ `workspaceSymbol/resolve`
- ✅ `workspace/willCreateFiles`
- ✅ `workspace/willDeleteFiles`
- ✅ `workspace/willRenameFiles`
- ✅ `workspace/didCreateFiles`
- ✅ `workspace/didDeleteFiles`
- ✅ `workspace/didRenameFiles`
- ✅ `workspace/workDoneProgress/cancel` - server to client
- ✅ `workspace/workDoneProgress/create` - server to client