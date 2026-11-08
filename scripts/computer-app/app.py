# The GTK test window of the computer check: pressing the button writes the field to the file named first.
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

window = Gtk.Window(title="测试窗口")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
name = Gtk.Entry()
name.get_accessible().set_name("姓名")
secret = Gtk.Entry()
secret.set_visibility(False)
secret.get_accessible().set_name("口令")
button = Gtk.Button(label="确定")


def done(_button):
    with open(sys.argv[1], "w", encoding="utf-8") as out:
        out.write(name.get_text())
    Gtk.main_quit()


button.connect("clicked", done)
box.add(name)
box.add(secret)
box.add(button)
window.add(box)
window.show_all()
Gtk.main()
