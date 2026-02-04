import SwiftUI
import Observation

struct ContentView: View {
    @Bindable var appState: AppState
    let startError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("tim-gui")
                        .font(.title2)
                    Text("Listening on http://127.0.0.1:8123/messages")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            if let startError {
                Text(startError)
                    .foregroundStyle(.red)
            }

            List(appState.items) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.message)
                        .font(.headline)
                    Text(item.workspacePath)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(item.receivedAt, style: .time)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
        }
        .padding(16)
        .frame(minWidth: 520, minHeight: 360)
    }
}

#Preview {
    ContentView(
        appState: {
            let state = AppState()
            state.ingest(.init(message: "Example message", workspacePath: "/tmp/example"))
            return state
        }(),
        startError: nil
    )
}
