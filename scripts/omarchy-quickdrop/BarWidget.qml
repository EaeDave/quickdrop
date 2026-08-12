import QtQuick
import qs.Ui

BarWidget {
  id: root
  moduleName: "quickdrop.bar"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰇚"
    tooltipText: "QuickDrop\nDrop files to upload"

    onPressed: function(mouseButton) {
      if (mouseButton !== Qt.LeftButton || !root.bar) return
      var launcher = String(root.setting("launcher", "quickdrop-launcher"))
      root.bar.run(root.bar.shellQuote(launcher))
    }
  }
}
