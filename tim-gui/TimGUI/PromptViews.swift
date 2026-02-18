import SwiftUI

// MARK: - PromptContainerView

struct PromptContainerView: View {
    let prompt: PromptRequestPayload
    let onResponse: (PromptResponseValue) async throws -> Void
    @State private var isSending = false
    @State private var sendError: String?
    @State private var errorVersion = 0

    var body: some View {
        VStack(spacing: 0) {
            Divider()

            VStack(alignment: .leading, spacing: 12) {
                Text(self.prompt.promptConfig.message)
                    .font(.headline)
                    .frame(maxWidth: .infinity, alignment: .leading)

                switch self.prompt.promptType {
                case "confirm":
                    ConfirmPromptView(
                        config: self.prompt.promptConfig,
                        isSending: self.isSending,
                        onResponse: self.handleResponse)
                case "input":
                    InputPromptView(
                        config: self.prompt.promptConfig,
                        isSending: self.isSending,
                        onResponse: self.handleResponse)
                case "select":
                    SelectPromptView(
                        config: self.prompt.promptConfig,
                        isSending: self.isSending,
                        onResponse: self.handleResponse)
                case "checkbox":
                    CheckboxPromptView(
                        config: self.prompt.promptConfig,
                        isSending: self.isSending,
                        onResponse: self.handleResponse)
                case "prefix_select":
                    PrefixSelectPromptView(
                        config: self.prompt.promptConfig,
                        isSending: self.isSending,
                        onResponse: self.handleResponse)
                default:
                    Text("Prompt type \"\(self.prompt.promptType)\" is not supported in the GUI.")
                        .foregroundStyle(.secondary)
                        .font(.callout)
                }

                if let sendError {
                    Text(sendError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(12)
        }
        .background(.ultraThinMaterial)
    }

    private func handleResponse(_ value: PromptResponseValue) {
        guard !self.isSending else { return }
        self.isSending = true
        self.sendError = nil
        Task {
            do {
                try await self.onResponse(value)
            } catch {
                self.sendError = "Failed to send prompt response"
                self.errorVersion += 1
                let capturedVersion = self.errorVersion
                Task {
                    try? await Task.sleep(for: .seconds(3))
                    if self.errorVersion == capturedVersion {
                        withAnimation {
                            self.sendError = nil
                        }
                    }
                }
            }
            self.isSending = false
        }
    }
}

// MARK: - ConfirmPromptView

struct ConfirmPromptView: View {
    let config: PromptConfigPayload
    let isSending: Bool
    let onResponse: (PromptResponseValue) -> Void

    private var defaultIsYes: Bool {
        if case let .bool(b) = self.config.defaultValue {
            return b
        }
        return true
    }

    var body: some View {
        HStack(spacing: 12) {
            if self.defaultIsYes {
                Button("Yes") { self.onResponse(.bool(true)) }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isSending)
                Button("No") { self.onResponse(.bool(false)) }
                    .buttonStyle(.bordered)
                    .disabled(self.isSending)
            } else {
                Button("Yes") { self.onResponse(.bool(true)) }
                    .buttonStyle(.bordered)
                    .disabled(self.isSending)
                Button("No") { self.onResponse(.bool(false)) }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isSending)
            }
        }
    }
}

// MARK: - InputPromptView

struct InputPromptView: View {
    let config: PromptConfigPayload
    let isSending: Bool
    let onResponse: (PromptResponseValue) -> Void
    @State private var text: String

    init(config: PromptConfigPayload, isSending: Bool, onResponse: @escaping (PromptResponseValue) -> Void) {
        self.config = config
        self.isSending = isSending
        self.onResponse = onResponse
        let defaultText: String = switch config.defaultValue {
        case let .string(s): s
        case let .int(n): String(n)
        case let .double(n): String(n)
        case let .bool(b): String(b)
        case .array, .object, .none: ""
        }
        self._text = State(initialValue: defaultText)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let hint = config.validationHint {
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                TextField("Enter value...", text: self.$text)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { self.submit() }
                    .disabled(self.isSending)

                Button("Submit") { self.submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || self.isSending)
            }
        }
    }

    private func submit() {
        let trimmed = self.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !self.isSending else { return }
        self.onResponse(.string(trimmed))
    }
}

// MARK: - SelectPromptView

struct SelectPromptView: View {
    let config: PromptConfigPayload
    let isSending: Bool
    let onResponse: (PromptResponseValue) -> Void
    @State private var selectedIndex: Int?

    init(config: PromptConfigPayload, isSending: Bool, onResponse: @escaping (PromptResponseValue) -> Void) {
        self.config = config
        self.isSending = isSending
        self.onResponse = onResponse
        if let defaultValue = config.defaultValue,
           let choices = config.choices,
           let idx = choices
               .firstIndex(where: {
                   $0.value == defaultValue || $0.value == nil && $0.name == Self.displayString(for: defaultValue)
               })
        {
            self._selectedIndex = State(initialValue: idx)
        } else {
            self._selectedIndex = State(initialValue: nil)
        }
    }

    /// Extract a display string from a PromptResponseValue for fallback matching.
    private static func displayString(for value: PromptResponseValue) -> String {
        switch value {
        case let .string(s): s
        case let .int(n): String(n)
        case let .double(n): String(n)
        case let .bool(b): String(b)
        case .array, .object: ""
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let choices = config.choices {
                ForEach(Array(choices.enumerated()), id: \.offset) { index, choice in
                    Button(action: { self.selectedIndex = index }) {
                        HStack(spacing: 8) {
                            Image(systemName: self.selectedIndex == index ? "circle.inset.filled" : "circle")
                                .foregroundStyle(self.selectedIndex == index ? .blue : .secondary)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(choice.name)
                                    .foregroundStyle(.primary)
                                if let description = choice.description {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }

            Button("Submit") {
                guard let idx = selectedIndex,
                      let choices = config.choices,
                      idx < choices.count
                else { return }
                let choice = choices[idx]
                self.onResponse(choice.value ?? .string(choice.name))
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.selectedIndex == nil || self.isSending)
        }
    }
}

// MARK: - CheckboxPromptView

struct CheckboxPromptView: View {
    let config: PromptConfigPayload
    let isSending: Bool
    let onResponse: (PromptResponseValue) -> Void
    @State private var checkedStates: [Bool]

    init(config: PromptConfigPayload, isSending: Bool, onResponse: @escaping (PromptResponseValue) -> Void) {
        self.config = config
        self.isSending = isSending
        self.onResponse = onResponse
        let states = config.choices?.map { $0.checked ?? false } ?? []
        self._checkedStates = State(initialValue: states)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let choices = config.choices {
                ForEach(Array(choices.enumerated()), id: \.offset) { index, choice in
                    Button(action: {
                        if index < self.checkedStates.count {
                            self.checkedStates[index].toggle()
                        }
                    }) {
                        HStack(spacing: 8) {
                            Image(
                                systemName: (index < self.checkedStates.count && self.checkedStates[index])
                                    ? "checkmark.square.fill" : "square")
                                .foregroundStyle(
                                    (index < self.checkedStates.count && self.checkedStates[index])
                                        ? .blue : .secondary)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(choice.name)
                                    .foregroundStyle(.primary)
                                if let description = choice.description {
                                    Text(description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }

            Button("Submit") {
                guard let choices = config.choices else { return }
                let selected = zip(choices, checkedStates)
                    .filter(\.1)
                    .map { $0.0.value ?? .string($0.0.name) }
                self.onResponse(.array(selected))
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.isSending)
        }
    }
}

// MARK: - PrefixSelectPromptView

enum PrefixSelectCommandNormalizer {
    static func extractCommandAfterCd(_ command: String) -> String {
        let pattern = #"^cd\s+(?:"[^"]+"|'[^']+'|[^\s]+)\s*&&\s*(.+)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return command
        }

        let range = NSRange(command.startIndex ..< command.endIndex, in: command)
        guard let match = regex.firstMatch(in: command, options: [], range: range),
              match.numberOfRanges > 1,
              let commandRange = Range(match.range(at: 1), in: command)
        else {
            return command
        }

        return String(command[commandRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct PrefixSelectPromptView: View {
    let config: PromptConfigPayload
    let isSending: Bool
    let onResponse: (PromptResponseValue) -> Void
    @State private var selectedWordCount: Int
    @State private var isExact: Bool = false

    private let normalizedCommand: String
    private let words: [String]

    init(config: PromptConfigPayload, isSending: Bool, onResponse: @escaping (PromptResponseValue) -> Void) {
        self.config = config
        self.isSending = isSending
        self.onResponse = onResponse
        let normalized = if let command = config.command {
            PrefixSelectCommandNormalizer.extractCommandAfterCd(command)
        } else {
            ""
        }
        self.normalizedCommand = normalized
        let w = normalized
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
        self.words = w
        self._selectedWordCount = State(initialValue: w.count)
    }

    var body: some View {
        if self.config.command == nil {
            Text("Error: No command provided for prefix select prompt.")
                .foregroundStyle(.red)
                .font(.callout)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                FlowLayout(spacing: 6) {
                    ForEach(Array(self.words.enumerated()), id: \.offset) { index, word in
                        let isSelected = self.isExact || index < self.selectedWordCount

                        Button(action: {
                            self.isExact = false
                            self.selectedWordCount = index + 1
                        }) {
                            Text(word)
                                .font(.system(.body, design: .monospaced))
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(
                                    isSelected
                                        ? (self.isExact ? Color.blue.opacity(0.3) : Color.green.opacity(0.3))
                                        : Color.secondary.opacity(0.15))
                                .foregroundStyle(isSelected ? .primary : .secondary)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        .buttonStyle(.plain)
                    }
                }

                HStack(spacing: 12) {
                    Toggle("Exact", isOn: self.$isExact)
                        .toggleStyle(.checkbox)
                        .onChange(of: self.isExact) { _, newValue in
                            if newValue {
                                self.selectedWordCount = self.words.count
                            }
                        }

                    Spacer()

                    Button("Submit") {
                        let command: String = if self.isExact {
                            self.normalizedCommand
                        } else {
                            self.words.prefix(self.selectedWordCount).joined(separator: " ")
                        }
                        self.onResponse(.object([
                            "exact": .bool(self.isExact),
                            "command": .string(command),
                        ]))
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isSending)
                }
            }
        }
    }
}

// MARK: - FlowLayout

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        self.arrangeSubviews(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        let result = self.arrangeSubviews(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: .unspecified)
        }
    }

    private struct ArrangementResult {
        var size: CGSize
        var positions: [CGPoint]
    }

    private func arrangeSubviews(proposal: ProposedViewSize, subviews: Subviews) -> ArrangementResult {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)

            if x + size.width > maxWidth, x > 0 {
                y += rowHeight + self.spacing
                x = 0
                rowHeight = 0
            }

            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + self.spacing
            totalWidth = max(totalWidth, x - self.spacing)
        }

        let totalHeight = y + rowHeight
        return ArrangementResult(
            size: CGSize(width: totalWidth, height: totalHeight),
            positions: positions)
    }
}
